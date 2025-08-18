import {DurableObject} from 'cloudflare:workers'
import {addSeconds} from 'date-fns'
import {ClaimSchema, Env, claimSchema} from '../types'
import {validateClaim} from '../utils/github'
import {Key, issueToken} from '../utils/oidc'
import {retry} from '../utils/retry'

export interface InitData {
  issuer: string
  claimData: ClaimSchema
  exchangeURL: string
}

export class Claim extends DurableObject<Env['Bindings']> {
  constructor(ctx: DurableObjectState, env: Env['Bindings']) {
    super(ctx, env)
  }

  async claim(data: InitData) {
    const result = claimSchema.safeParse(data.claimData)
    if (!result.success) throw new Error(`Invalid claim: ${result.error.issues}`)

    const challengeCode = crypto.randomUUID()

    await this.ctx.storage.setAlarm(addSeconds(new Date(), 5 * 60))
    await this.ctx.storage.put('issuer', data.issuer)
    await this.ctx.storage.put('claimData', result.data)
    await this.ctx.storage.put('challengeCode', challengeCode)

    console.log(`Started claim ${data.exchangeURL}`, result.data)

    return {challengeCode, exchangeURL: data.exchangeURL}
  }

  async exchange() {
    const exchanged = await this.ctx.storage.get<boolean>('exchanged')
    if (exchanged === true) throw new Error('challenge already used')

    const claimData = await this.ctx.storage.get<ClaimSchema>('claimData')
    if (!claimData) throw new Error('no claim data')

    const challengeCode = await this.ctx.storage.get<string>('challengeCode')
    if (!challengeCode) throw new Error('no challenge code')

    const issuer = await this.ctx.storage.get<string>('issuer')
    if (!issuer) throw new Error('no issuer')

    const keyID = await this.env.KEYS.get('latest-key', 'text')
    if (!keyID) throw new Error('no key')

    const key = await this.env.KEYS.get<Key>(`key:${keyID}`, 'json')
    if (!key) throw new Error('no key')

    console.log('Validating claim', claimData)

    const validatedClaims = await retry(
      () =>
        validateClaim(
          this.env,
          {
            eventName: claimData.eventName,
            owner: claimData.repo.owner,
            repo: claimData.repo.repo,
            runID: claimData.runID,
            attempt: claimData.attempt,
          },
          challengeCode,
        ),
      {retries: 4, delay: 2000},
    )

    const token = await issueToken({
      issuer,
      keyID,
      privateKey: key.privateKey,
      audience: claimData.aud ?? 'https://github.com',
      claims: validatedClaims,
    })

    return token
  }

  async alarm() {
    console.log('Cleaning up Claim')
    await this.ctx.storage.deleteAll()
    await this.ctx.storage.deleteAlarm()
  }

  // Not used
  webSocketMessage() {}
  webSocketClose() {}
  webSocketError() {}
}
