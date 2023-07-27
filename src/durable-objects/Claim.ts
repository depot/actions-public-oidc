import {addSeconds} from 'date-fns'
import {Hono} from 'hono'
import {ClaimSchema, Env, claimSchema} from '../types'
import {validateClaim} from '../utils/github'
import {Key, issueToken} from '../utils/oidc'

export interface InitData {
  issuer: string
  claimData: ClaimSchema
  exchangeURL: string
}

export class Claim implements DurableObject {
  router = new Hono<Env>()

  constructor(public state: DurableObjectState, public env: Env['Bindings']) {
    this.router.onError((err, {json}) => {
      console.error(err)
      return json({error: err.message}, 500)
    })
    this.router.notFound(({json}) => json({error: 'not found'}, 404))

    this.router.post('/claim', async ({req, json}) => {
      const data: InitData = await req.json()

      const result = claimSchema.safeParse(data.claimData)
      if (!result.success) return json({error: 'Invalid claim', issues: result.error.issues}, 400)

      const challengeCode = crypto.randomUUID()

      await state.storage.setAlarm(addSeconds(new Date(), 60))
      await state.storage.put('issuer', data.issuer)
      await state.storage.put('claimData', result.data)
      await state.storage.put('challengeCode', challengeCode)

      console.log(`Started claim ${data.exchangeURL}`, result.data)

      return json({challengeCode, exchangeURL: data.exchangeURL})
    })

    this.router.post('/exchange', async ({text, json}) => {
      const exchanged = await state.storage.get<boolean>('exchanged')
      if (exchanged === true) return json({error: 'challenge already used'}, 400)

      const claimData = await state.storage.get<ClaimSchema>('claimData')
      if (!claimData) return json({error: 'no claim data'}, 500)

      const challengeCode = await state.storage.get<string>('challengeCode')
      if (!challengeCode) return json({error: 'no challenge code'}, 500)

      const issuer = await state.storage.get<string>('issuer')
      if (!issuer) return json({error: 'no issuer'}, 500)

      const keyID = await env.KEYS.get('latest-key', 'text')
      if (!keyID) return json({error: 'no key'}, 500)

      const key = await env.KEYS.get<Key>(`key:${keyID}`, 'json')
      if (!key) return json({error: 'no key'}, 500)

      console.log('Validating claim', claimData)

      const validatedClaims = await validateClaim(
        env,
        {
          eventName: claimData.eventName,
          owner: claimData.repo.owner,
          repo: claimData.repo.repo,
          runID: claimData.runID,
        },
        challengeCode,
      )

      const token = await issueToken({
        issuer,
        keyID,
        privateKey: key.privateKey,
        audience: claimData.aud ?? 'https://github.com',
        claims: validatedClaims,
      })

      return text(token)
    })
  }

  async fetch(request: Request) {
    return this.router.fetch(request, this.env, {...this.state, passThroughOnException: () => {}})
  }

  async alarm() {
    console.log('Cleaning up')
    await this.state.storage.deleteAll()
    await this.state.storage.deleteAlarm()
  }

  // Not used
  webSocketMessage() {}
  webSocketClose() {}
  webSocketError() {}
}
