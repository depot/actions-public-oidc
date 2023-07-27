import {StableSocket} from '@github/stable-socket'
import {isAbortError} from 'abort-controller-x'
import {addSeconds} from 'date-fns'
import {Hono} from 'hono'
import {Env} from '../types'
import {EventIterator} from '../utils/EventIterator'

export interface InitData {
  websocketURL: string
  challengeCode: string
}

export class Watcher implements DurableObject {
  router = new Hono<Env>()

  watcher: Promise<void> | undefined
  challenges: Map<string, boolean> = new Map()
  controller: AbortController | undefined

  constructor(public state: DurableObjectState, public env: Env['Bindings']) {
    this.router.onError((err, {json}) => {
      console.error(err)
      return json({error: err.message}, 500)
    })

    this.router.notFound(({json}) => json({error: 'not found'}, 404))

    this.router.post('/validate', async ({req, json}) => {
      await state.storage.setAlarm(addSeconds(new Date(), 60))

      const {websocketURL, challengeCode}: InitData = await req.json()

      if (this.challenges.get(challengeCode) === true) return json({validated: true})
      this.challenges.set(challengeCode, false)

      const session = await env.KEYS.get('github-session')
      if (!session) return json({error: 'no github session'}, 500)
      await this.startWatcher(websocketURL)

      return json({validated: false})
    })
  }

  async fetch(request: Request) {
    return this.router.fetch(request, this.env, {...this.state, passThroughOnException: () => {}})
  }

  async alarm() {
    console.log('Cleaning up Watcher')
    this.controller?.abort()
    await this.state.storage.deleteAll()
    await this.state.storage.deleteAlarm()
  }

  async startWatcher(websocketURL: string) {
    if (this.watcher) return

    const session = await this.env.KEYS.get('github-session')
    if (!session) throw new Error('no github session')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10 * 1000)

    console.log(`Starting watcher for ${websocketURL}`)
    this.watcher = startWebsocketWatcher(session, controller.signal, websocketURL, (m) =>
      this.handleMessage(m),
    ).finally(() => {
      console.log(`Watcher for ${websocketURL} finished`)
      this.watcher = undefined
      clearTimeout(timeout)
    })
    this.controller = controller
  }

  async handleMessage(message: LogMessage) {
    const lines = message.arguments.flatMap((arg) => arg.lines)
    for (const code of this.challenges.keys()) {
      if (lines.some((line) => line.includes(code))) {
        this.challenges.set(code, true)
        return
      }
    }
  }

  // Not used
  webSocketMessage() {}
  webSocketClose() {}
  webSocketError() {}
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
    },
  })
  const body = await res.json<{data?: {authenticated_url: string}}>()
  if (!body || !body.data || !body.data.authenticated_url) return

  const res2 = await fetch(body.data.authenticated_url)
  const body2 = await res2.json<{logStreamWebSocketUrl?: string}>()
  if (!body2.logStreamWebSocketUrl) return

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
      await onMessage(message)
    }
  } catch (error) {
    if (!isAbortError(error)) console.log('Websocket Error', error)
  } finally {
    ws?.close()
  }
}
