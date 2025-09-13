// Import otel first
import './utils/otel'

// Import everything else after
import {otel} from '@hono/otel'
import {Hono} from 'hono'
import {handle} from 'hono/aws-lambda'
import {logger as loggerMiddleware} from 'hono/logger'
import {claimSchema} from './types'
import {authenticateAdmin} from './utils/auth'
import {
  createClaim,
  exchangeClaim,
  getAllKeys,
  getLatestKey,
  setGitHubSession,
  setLatestKey,
  storeKey,
} from './utils/dynamodb'
import {validateClaim} from './utils/github'
import {logger} from './utils/logger'
import {generateKey, issueToken} from './utils/oidc'
import {retry} from './utils/retry'

const app = new Hono()
app.use(otel())
app.use(loggerMiddleware())
export const handler = handle(app)

// Common endpoints ***********************************************************

app.onError((err, {json}) => {
  console.error(err)
  return json({error: err.message}, 500)
})
app.notFound(({json}) => json({error: 'not found'}, 404))
app.get('/', ({json}) => json({ok: true, docs: 'https://github.com/depot/actions-public-oidc'}))

// Token exchange endpoints ***************************************************

app.post('/claim', async ({req, json}) => {
  const claimData = await req.json()

  const result = claimSchema.safeParse(claimData)
  if (!result.success) return json({error: `Invalid claim: ${result.error.issues}`}, 400)

  const issuer = new URL(req.url).origin
  const claimId = crypto.randomUUID()
  const challengeCode = crypto.randomUUID()

  await createClaim({claimId, issuer, claimData: result.data, challengeCode})
  logger.info(`Started claim ${issuer}/exchange/${claimId}`, result.data)

  return json({challengeCode, exchangeURL: `${issuer}/exchange/${claimId}`})
})

app.post('/exchange/:id', async ({req, text}) => {
  const claimId = req.param('id')

  const claim = await exchangeClaim(claimId)
  if (!claim) throw new Error('challenge already used or not found')

  const {issuer, claimData, challengeCode} = claim

  const key = await getLatestKey()
  if (!key) throw new Error('no key')

  logger.info('Validating claim', claimData)

  const validatedClaims = await retry(
    () =>
      validateClaim(
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
    keyID: key.id,
    privateKey: key.privateKey,
    audience: claimData.aud ?? 'https://github.com',
    claims: validatedClaims,
  })

  return text(token)
})

// OIDC endpoints *************************************************************

app.get('/.well-known/openid-configuration', ({req, json}) => {
  const issuer = new URL(req.url).origin
  return json({
    issuer: `${issuer}`,
    jwks_uri: `${issuer}/.well-known/jwks`,
    subject_types_supported: ['public', 'pairwise'],
    response_types_supported: ['id_token'],
    claims_supported: [
      'sub',
      'aud',
      'exp',
      'iat',
      'iss',
      'jti',
      'nbf',

      'actor_id',
      'actor',
      'event_name',
      'head_ref',
      'head_repository_id',
      'head_repository_owner_id',
      'head_repository_owner',
      'head_repository',
      'head_sha',
      'job_id',
      'repository_id',
      'repository_owner_id',
      'repository_owner',
      'repository_visibility',
      'repository',
      'run_attempt',
      'run_id',
      'run_number',
      'workflow',
    ],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid'],
  })
})

app.get('/.well-known/jwks', async ({json}) => {
  const keys = await getAllKeys()
  const jwks = {
    keys: keys.map((key) => ({
      kid: key.id,
      use: 'sig',
      kty: key.publicKey.kty,
      alg: key.publicKey.alg,
      n: key.publicKey.n,
      e: key.publicKey.e,
    })),
  }
  return json(jwks)
})

// Admin endpoints ************************************************************

const keyExpirationSeconds = 60 * 60 * 24 * 30 // 30 days

app.post('/-/generate-key', async ({req, json}) => {
  await authenticateAdmin(req)
  const key = await generateKey()
  await storeKey(key, keyExpirationSeconds)
  await setLatestKey(key.id)
  return json({ok: true})
})

app.get('/-/keys', async ({req, json}) => {
  await authenticateAdmin(req)
  const keys = await getAllKeys()
  return json(keys)
})

app.post('/-/github-session', async ({req, json}) => {
  await authenticateAdmin(req)
  const body = await req.json()
  await setGitHubSession(body.session)
  return json({ok: true})
})
