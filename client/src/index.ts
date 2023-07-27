import * as core from '@actions/core'
import * as github from '@actions/github'
import {HttpClient} from '@actions/http-client'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const client = new HttpClient('@depot/actions-public-oidc-client')

interface Challenge {
  challengeCode: string
  exchangeURL: string
}

interface ErrorResponse {
  error: string
}

export async function getIDToken(aud?: string): Promise<string> {
  if (github.context.eventName !== 'pull_request') throw new Error('not a pull request')
  const res = await client.postJson<Challenge | ErrorResponse>('https://actions-public-oidc.depot.dev/claim', {
    aud,
    eventName: github.context.eventName,
    repo: `${github.context.repo.owner}/${github.context.repo.repo}`,
    runID: github.context.runId.toString(),
  })

  if (res.statusCode >= 400) {
    if (!res.result) throw new Error(`HTTP ${res.statusCode}: no response`)
    if ('error' in res.result) throw new Error(res.result.error)
    throw new Error(`HTTP ${res.statusCode}: ${JSON.stringify(res.result)}`)
  }

  if (!res.result) throw new Error(`HTTP ${res.statusCode}: no response`)
  if ('error' in res.result) throw new Error(res.result.error)
  const {challengeCode, exchangeURL} = res.result

  const interval = setInterval(() => {
    core.info(`Waiting for OIDC auth challenge ${challengeCode}`)
  }, 1000)

  try {
    for (let i = 1; i < 60; i++) {
      const res = await client.post(exchangeURL, '')
      if (res.message.statusCode === 200) return await res.readBody()
      await sleep(1000)
    }
    throw new Error(`OIDC auth challenge ${challengeCode} timed out`)
  } finally {
    clearInterval(interval)
  }
}
