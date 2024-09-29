import {request} from '@octokit/request'
import {Env, TokenClaims} from '../types'

interface ClaimData {
  owner: string
  repo: string
  eventName: string
  runID: number
}

export async function validateClaim(
  env: Env['Bindings'],
  claimData: ClaimData,
  challengeCode: string,
): Promise<TokenClaims> {
  const session = await env.KEYS.get('github-session')
  if (!session) throw new Error('no github session')

  const {data: run} = await request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
    owner: claimData.owner,
    repo: claimData.repo,
    run_id: claimData.runID,
    headers: {authorization: `token ${env.GITHUB_TOKEN}`},
  })

  if (run.status !== 'in_progress') throw new Error('run not in progress')
  if (run.repository.private) throw new Error('repository is private')

  const {data} = await request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
    owner: claimData.owner,
    repo: claimData.repo,
    run_id: claimData.runID,
    headers: {authorization: `token ${env.GITHUB_TOKEN}`},
  })

  const runningJobs = data.jobs.filter((job) => job.status === 'in_progress')
  if (runningJobs.length === 0) throw new Error('no running jobs')

  const promises: Promise<{jobID: number; validated: boolean}>[] = []

  for (const job of runningJobs) {
    const jobID = job.id
    const headSHA = job.head_sha
    if (!jobID || !headSHA) continue

    const jobURL = `https://github.com/${claimData.owner}/${claimData.repo}/actions/runs/${claimData.runID}/jobs/${jobID}`

    promises.push(
      validateChallengeCodeWithBackscroll({
        session,
        org: claimData.owner,
        repo: claimData.repo,
        runID: claimData.runID,
        jobID: jobID,
        code: challengeCode,
      }).then((validated) => {
        return {jobID, validated}
      }),
    )

    promises.push(
      validateChallengeCode(
        env,
        `https://github.com/${claimData.owner}/${claimData.repo}/commit/${headSHA}/checks/${jobID}/live_logs`,
        challengeCode,
      ).then((validated) => {
        return {jobID, validated}
      }),
    )
  }

  const all = await Promise.allSettled(promises)

  const validated = all.find((result) => result.status === 'fulfilled' && result.value.validated)
  if (!validated) throw new Error('no validated jobs')
  if (validated.status === 'rejected') throw new Error('no validated jobs')
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
    job_id: validated.value.jobID.toString(),
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

async function validateChallengeCode(env: Env['Bindings'], url: string, code: string): Promise<boolean> {
  const stub = env.WATCHER.get(env.WATCHER.idFromName(url))
  const res = await stub.fetch('http://watcher/validate', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({websocketURL: url, challengeCode: code}),
  })
  const data = await res.json<{validated: boolean}>()
  return data.validated
}

interface BackscrollArgs {
  session: string
  org: string
  repo: string
  runID: number
  jobID: number
  code: string
}

async function validateChallengeCodeWithBackscroll(args: BackscrollArgs): Promise<boolean> {
  console.log('Validating challenge with backscroll', args)

  try {
    const {session, org, repo, runID, jobID, code} = args
    const backscrollRegex = new RegExp(`/${org}/${repo}/actions/runs/${runID}/jobs/(\\w+)/steps/[\\w-]+/backscroll`)
    const pageRes = await fetch(`https://github.com/${org}/${repo}/actions/runs/${runID}/job/${jobID}`, {
      headers: {
        Accept: 'text/html,*/*',
        Cookie: `user_session=${session}`,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      },
    })
    const pageText = await pageRes.text()
    const match = pageText.match(backscrollRegex)
    if (!match) {
      console.log('No backscroll job ID found', args)
      return false
    }
    const backscrollJobID = match[1]

    const jobURL = `https://github.com/${org}/${repo}/actions/runs/${runID}/jobs/${backscrollJobID}`
    const stepsRes = await fetch(`${jobURL}/steps`, {
      headers: {
        Accept: 'application/json',
        Cookie: `user_session=${session}`,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      },
    })
    const body = await stepsRes.json() as {id: string; status: string}[]
    const runningSteps = body.filter((step) => step.status === 'in_progress')

    for (const step of runningSteps) {
      try {
        console.log('Fetching backscroll for', step)
        const backscrollRes = await fetch(`${jobURL}/steps/${step.id}/backscroll`, {
          headers: {
            Accept: 'application/json',
            Cookie: `user_session=${session}`,
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          },
        })
        const body = await backscrollRes.json() as {lines?: {line: string}[]}

        if (body.lines?.some((line) => line.line.includes(code))) {
          console.log(`Challenge ${code} validated with backscroll`, args)
          return true
        }
      } catch (e) {
        console.log('Error checking backscroll for step', step, e)
      }
    }
  } catch (e) {
    console.log('Error fething backscroll', e, args)
  }

  return false
}
