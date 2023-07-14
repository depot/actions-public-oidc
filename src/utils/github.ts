import {StableSocket} from '@github/stable-socket'
import {request} from '@octokit/request'
import {isAbortError} from 'abort-controller-x'
import {Env, TokenClaims} from '../types'
import {EventIterator} from './EventIterator'

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

  const controller = new AbortController()

  const runningJobs = data.jobs.filter((job) => job.status === 'in_progress')
  if (runningJobs.length === 0) throw new Error('no running jobs')

  const promises: Promise<{jobID: number; validated: boolean}>[] = []

  for (const job of runningJobs) {
    const jobID = job.id
    const headSHA = job.head_sha
    if (!jobID || !headSHA) continue

    promises.push(
      validateChallengeCode(
        env,
        controller.signal,
        `https://github.com/depot/actions-test/commit/${headSHA}/checks/${jobID}/live_logs`,
        challengeCode,
      ).then((validated) => {
        if (validated) controller.abort()
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

const RECORD_SEPARATOR = String.fromCharCode(0x1e)

interface LogMessage {
  type: number
  target: string
  arguments: {lines: string[]}[]
}

export async function validateChallengeCode(
  env: Env['Bindings'],
  signal: AbortSignal,
  url: string,
  code: string,
): Promise<boolean> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Cookie: env.SESSION_COOKIE,
    },
  })
  const body = await res.json<{data?: {authenticated_url: string}}>()
  if (!body || !body.data || !body.data.authenticated_url) return false

  const res2 = await fetch(body.data.authenticated_url)
  const body2 = await res2.json<{logStreamWebSocketUrl?: string}>()
  if (!body2.logStreamWebSocketUrl) return false

  const wsURL: string = body2.logStreamWebSocketUrl

  const {searchParams} = new URL(wsURL)
  const tenantId = searchParams.get('tenantId') ?? ''
  const runId = searchParams.get('runId') ?? ''

  let ws: StableSocket | undefined

  const iterator = new EventIterator<LogMessage>(({push}) => {
    ws = new StableSocket(
      wsURL,
      {
        socketDidOpen() {
          ws?.send(
            JSON.stringify({
              protocol: 'json',
              version: 1,
            }) + RECORD_SEPARATOR,
          )
          ws?.send(
            JSON.stringify({
              arguments: [tenantId, +runId],
              target: 'WatchRunAsync',
              type: 1,
            }) + RECORD_SEPARATOR,
          )
        },
        socketDidClose() {},
        socketDidReceiveMessage(_socket, message) {
          const records = message.split(RECORD_SEPARATOR)
          for (const record of records) {
            if (!record) continue
            console.log('RECV   ', record)
            const data: LogMessage = JSON.parse(record)
            if (data.type === 1 && data.target === 'logConsoleLines') {
              push(data)
            }
          }
        },
        socketDidFinish() {},
        socketShouldRetry() {
          return true
        },
      },
      {timeout: 4000, attempts: 10},
    )
    ws.open()

    signal.addEventListener('abort', () => {
      ws?.close()
    })

    return () => ws?.close()
  })

  try {
    for await (const message of iterator) {
      signal.throwIfAborted()
      const lines = message.arguments.flatMap((arg) => arg.lines)
      if (lines.some((line) => line.includes(code))) {
        return true
      }
    }
  } catch (error) {
    if (!isAbortError(error)) console.log('Websocket Error', error)
    return false
  } finally {
    ws?.close()
  }

  return false
}
