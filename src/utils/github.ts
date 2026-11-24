import {HTTPException} from 'hono/http-exception'
import {Octokit, RequestError} from 'octokit'
import type {TokenClaims} from '../types'
import {getGitHubSession} from './dynamodb'
import {logger} from './logger'
import type {Redacted} from './redacted'
import {userAgent} from './userAgent'

function getGitHubTokens(): string[] {
  const tokensEnv = process.env.GITHUB_TOKENS
  if (tokensEnv) {
    const tokens = tokensEnv
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
    if (tokens.length > 0) return tokens
  }

  const singleToken = process.env.GITHUB_TOKEN
  if (singleToken) return [singleToken]

  return []
}

function getRandomToken(): string {
  const tokens = getGitHubTokens()
  if (tokens.length === 0) {
    throw new Error('No GitHub tokens configured. Set GITHUB_TOKENS or GITHUB_TOKEN environment variable.')
  }
  return tokens[Math.floor(Math.random() * tokens.length)]
}

function createOctokit(): Octokit {
  return new Octokit({auth: getRandomToken()})
}

interface ClaimData {
  owner: string
  repo: string
  eventName: string
  runID: number
  attempt?: number
}

/**
 * GitHub answers 404 both for a run or attempt ID that does not exist and for a token that can no longer see the
 * repository, so the 404 keeps an error log with the run it asked for. Every other GitHub error keeps its own handling.
 */
async function githubRequest<T>(
  request: Promise<T>,
  context: {owner: string; repo: string; runID: number},
): Promise<T> {
  try {
    return await request
  } catch (err) {
    if (err instanceof RequestError && err.status === 404) {
      logger.error('GitHub run not found', {...context, message: err.message})
      throw new HTTPException(404, {message: 'github run not found'})
    }
    throw err
  }
}

export async function validateClaim(claimData: ClaimData, challengeCode: string): Promise<TokenClaims> {
  const session = await getGitHubSession()
  if (!session) throw new Error('no github session')

  logger.info('Validating claim', claimData)

  const octokit = createOctokit()

  const {data: run} = await githubRequest(
    claimData.attempt
      ? octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}', {
          owner: claimData.owner,
          repo: claimData.repo,
          run_id: claimData.runID,
          attempt_number: claimData.attempt,
        })
      : octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
          owner: claimData.owner,
          repo: claimData.repo,
          run_id: claimData.runID,
        }),
    {owner: claimData.owner, repo: claimData.repo, runID: claimData.runID},
  )

  logger.info('Fetched GitHub run data', {claimData, run})

  if (run.event !== 'pull_request') throw new HTTPException(422, {message: 'run is not a pull request'})
  if (run.repository.private) throw new HTTPException(403, {message: 'repository is private'})
  if (!run.status) throw new Error('run status unavailable')
  if (run.status === 'completed' || run.conclusion !== null) {
    throw new HTTPException(409, {message: 'run already completed'})
  }

  const jobs = await githubRequest(
    claimData.attempt
      ? octokit.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', {
          owner: claimData.owner,
          repo: claimData.repo,
          run_id: claimData.runID,
          attempt_number: claimData.attempt,
        })
      : octokit.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
          owner: claimData.owner,
          repo: claimData.repo,
          run_id: claimData.runID,
        }),
    {owner: claimData.owner, repo: claimData.repo, runID: claimData.runID},
  )

  const runningJobs = jobs.filter((job) => job.status === 'in_progress')
  if (runningJobs.length === 0) throw new HTTPException(422, {message: 'no running jobs'})

  logger.info('Fetched running GitHub jobs data', {claimData, jobs: runningJobs})

  const promises: Promise<{jobID: number; validated: boolean; outcome: BackscrollOutcome}>[] = []

  for (const job of runningJobs) {
    const jobID = job.id
    const headSHA = job.head_sha
    if (!jobID || !headSHA) continue

    promises.push(
      validateChallengeCodeWithBackscroll({
        session,
        org: claimData.owner,
        repo: claimData.repo,
        runID: claimData.runID,
        jobID: jobID,
        code: challengeCode,
      }).then((result) => {
        return {jobID, ...result}
      }),
    )
  }

  const all = await Promise.allSettled(promises)
  const checks = all.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))

  const validated = checks.find((check) => check.validated)
  if (!validated) {
    // A page without its backscroll link means the session can no longer read the run, and an error means the check
    // itself failed. Both are faults of the issuer, so they stay 500 and keep their log.
    if (checks.some((check) => check.outcome === 'no_backscroll_link' || check.outcome === 'error')) {
      throw new Error('github session cannot read the run page')
    }
    throw new HTTPException(422, {message: 'no validated jobs'})
  }
  if (!run.triggering_actor) throw new Error('no triggering actor')

  const validatedClaims = {
    sub: `repo:${claimData.owner}/${claimData.repo}:pull_request`,
    actor_id: run.triggering_actor.id?.toString() ?? '',
    actor: run.triggering_actor.login,
    event_name: run.event,
    head_ref: run.head_branch ?? '',
    head_repository_id: run.head_repository.id.toString(),
    head_repository_owner_id: run.head_repository.owner.id.toString(),
    head_repository_owner: run.head_repository.owner.login,
    head_repository: run.head_repository.full_name,
    head_sha: run.head_sha,
    job_id: validated.jobID.toString(),
    repository_id: run.repository.id.toString(),
    repository_owner_id: run.repository.owner.id.toString(),
    repository_owner: run.repository.owner.login,
    repository_visibility: run.repository.private ? 'private' : 'public',
    repository: run.repository.full_name,
    run_attempt: run.run_attempt?.toString() ?? '',
    run_id: run.id.toString(),
    run_number: run.run_number.toString(),
    workflow: run.path,

    // It appears it's not possible to determine these values :(
    // base_ref: '...',
    // environment: '...',
    // job_workflow_ref: '...',
    // job_workflow_sha: '...',
    // ref: 'refs/pull/1/merge',
    // ref_type: 'branch',
    // runner_environment: '...',
    // workflow_ref: '...',
    // workflow_sha: '...',
  }

  return validatedClaims
}

interface BackscrollArgs {
  session: Redacted<string>
  org: string
  repo: string
  runID: number
  jobID: number
  code: string
}

/** Why a backscroll check returned; `no_backscroll_link` usually means the GitHub session is no longer valid. */
type BackscrollOutcome = 'validated' | 'no_backscroll_link' | 'no_running_steps' | 'code_not_found' | 'error'

interface ValidatedChallenge {
  validated: boolean
  outcome: BackscrollOutcome
}

/** Emits one `Backscroll validation` event per check, with the outcome and the context to debug it. */
async function validateChallengeCodeWithBackscroll(args: BackscrollArgs): Promise<ValidatedChallenge> {
  const {session, org, repo, runID, jobID, code} = args
  const cookie = `user_session=${session.value()}`
  const startedAt = Date.now()
  const event: Record<string, unknown> = {org, repo, runID, jobID, challengeCode: code}
  let attempts = 0
  let outcome: BackscrollOutcome = 'error'

  try {
    const backscrollRegex = new RegExp(`/${org}/${repo}/actions/runs/${runID}/jobs/(\\w+)/steps/[\\w-]+/backscroll`)
    const pageRes = await fetch(`https://github.com/${org}/${repo}/actions/runs/${runID}/job/${jobID}`, {
      headers: {
        Accept: 'text/html,*/*',
        Cookie: cookie,
        'User-Agent': userAgent,
      },
    })
    event.pageStatus = pageRes.status
    const pageText = await pageRes.text()
    const match = pageText.match(backscrollRegex)
    if (!match) {
      outcome = 'no_backscroll_link'
      return {validated: false, outcome}
    }
    const backscrollJobID = match[1]
    event.backscrollJobID = backscrollJobID

    const jobURL = `https://github.com/${org}/${repo}/actions/runs/${runID}/jobs/${backscrollJobID}`
    const stepsRes = await fetch(`${jobURL}/steps`, {
      headers: {
        Accept: 'application/json',
        Cookie: cookie,
        'User-Agent': userAgent,
      },
    })
    event.stepsStatus = stepsRes.status
    const body = (await stepsRes.json()) as {id: string; status: string}[]
    const runningSteps = body.filter((step) => step.status === 'in_progress')
    event.runningSteps = runningSteps.length

    if (!runningSteps.length) {
      outcome = 'no_running_steps'
      return {validated: false, outcome}
    }

    for (const step of runningSteps) {
      for (let i = 0; i < 4; i++) {
        attempts++
        try {
          const backscrollRes = await fetch(`${jobURL}/steps/${step.id}/backscroll`, {
            headers: {
              Accept: 'application/json',
              Cookie: cookie,
              'User-Agent': userAgent,
            },
          })
          event.backscrollStatus = backscrollRes.status
          const body = (await backscrollRes.json()) as {lines?: {line: string}[]}

          if (Array.isArray(body.lines)) {
            body.lines.reverse()
          }

          if (body.lines?.some((line) => line.line.includes(code))) {
            event.stepID = step.id
            outcome = 'validated'
            return {validated: true, outcome}
          }
        } catch (e) {
          event.lastAttemptError = `${e}`
        }

        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
    outcome = 'code_not_found'
  } catch (e) {
    event.error = `${e}`
  } finally {
    const context = {...event, attempts, outcome, durationMs: Date.now() - startedAt}
    if (outcome === 'error') logger.error('Backscroll validation', context)
    else logger.info('Backscroll validation', context)
  }

  return {validated: false, outcome}
}
