import {StableSocket} from '@github/stable-socket'
import {isAbortError} from 'abort-controller-x'
import {DurableObject} from 'cloudflare:workers'
import {addSeconds} from 'date-fns'
import type {Env} from '../types'
import {EventIterator} from '../utils/EventIterator'

export interface InitData {
  websocketURL: string
  challengeCode: string
}

export class Watcher extends DurableObject<Env['Bindings']> {
  watcher: Promise<void> | undefined
  controller: AbortController | undefined
  challenges: Map<string, boolean> = new Map()

  async validate({websocketURL, challengeCode}: InitData) {
    await this.ctx.storage.setAlarm(addSeconds(new Date(), 60))

    if (this.challenges.get(challengeCode) === true) return {validated: true}
    this.challenges.set(challengeCode, false)

    const session = await this.env.KEYS.get('github-session')
    if (!session) throw new Error('no github session')

    await this.startWatcher(websocketURL)

    return {validated: false}
  }

  async alarm() {
    console.log('Cleaning up Watcher')
    this.controller?.abort()
    await this.ctx.storage.deleteAll()
    await this.ctx.storage.deleteAlarm()
  }

  private async startWatcher(websocketURL: string) {
    if (this.watcher) return

    const session = await this.env.KEYS.get('github-session')
    if (!session) throw new Error('no github session')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10 * 1000)

    console.log(`Starting watcher for ${websocketURL}`)
    const watcher = startWebsocketWatcher(session, controller.signal, websocketURL, (m) => this.handleMessage(m))
      .catch((err) => {
        console.log(`Watcher for ${websocketURL} errored`, err)
      })
      .finally(() => {
        console.log(`Watcher for ${websocketURL} finished`)
        clearTimeout(timeout)
        if (this.watcher !== watcher) return
        this.watcher = undefined
        this.controller = undefined
      })

    this.watcher = watcher
    this.controller = controller
  }

  private stopWatcher() {
    this.controller?.abort()
    this.watcher = undefined
    this.controller = undefined
  }

  private async handleMessage(message: LogMessage) {
    const lines = message.arguments.flatMap((arg) => arg.lines)
    for (const code of this.challenges.keys()) {
      if (lines.some((line) => line.includes(code))) {
        console.log(`Challenge ${code} validated with websocket`)
        this.challenges.set(code, true)
        this.stopWatcher()
        return
      }
    }
  }
}

const RECORD_SEPARATOR = String.fromCharCode(0x1e)

interface LogMessage {
  type: number
  target: string
  arguments: {lines: string[]}[]
}

async function startWebsocketWatcher(
  session: string,
  signal: AbortSignal,
  url: string,
  onMessage: (message: LogMessage) => void | Promise<void>,
): Promise<void> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Cookie: `user_session=${session}`,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    },
  })
  const body = await res.json<{data?: {authenticated_url: string}}>()
  if (!body || !body.data || !body.data.authenticated_url)
    throw new Error(`no authenticated_url: ${res.status} ${JSON.stringify(body)}`)

  const res2 = await fetch(body.data.authenticated_url)
  const body2 = await res2.json<{logStreamWebSocketUrl?: string}>()
  if (!body2.logStreamWebSocketUrl) throw new Error('no logStreamWebSocketUrl')

  const wsURL: string = body2.logStreamWebSocketUrl

  const {searchParams} = new URL(wsURL)
  const tenantId = searchParams.get('tenantId') ?? ''
  const runId = searchParams.get('runId') ?? ''

  console.log(`Starting websocket for ${url}`)

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
      await onMessage(message)
    }
  } catch (error) {
    if (!isAbortError(error)) console.log('Websocket Error', error)
  } finally {
    ws?.close()
  }
}
