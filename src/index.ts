import {Hono} from 'hono'
import type {InitData} from './durable-objects/Claim'
import type {Env} from './types'
import {authenticateAdmin} from './utils/auth'
import type {Key} from './utils/oidc'
import {generateKey} from './utils/oidc'

const app = new Hono<Env>()
export default app
export {Claim} from './durable-objects/Claim'
export {Watcher} from './durable-objects/Watcher'

// Common endpoints ***********************************************************

app.onError((err, {json}) => {
  console.error(err)
  return json({error: err.message}, 500)
})
app.notFound(({json}) => json({error: 'not found'}, 404))
app.get('/', ({json}) => json({ok: true, docs: 'https://github.com/depot/actions-public-oidc'}))

// Token exchange endpoints ***************************************************

app.post('/claim', async ({env, req, json}) => {
  const issuer = new URL(req.url).origin
  const id = env.CLAIM.newUniqueId()
  const stub = env.CLAIM.get(id)
  const data: InitData = {claimData: await req.json(), issuer, exchangeURL: `${issuer}/exchange/${id.toString()}`}
  const res = await stub.claim(data)
  return json(res)
})

app.post('/exchange/:id', async ({env, req, text}) => {
  const id = req.param('id')
  const stub = env.CLAIM.get(env.CLAIM.idFromString(id))
  const res = await stub.exchange()
  return text(res)
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

app.get('/.well-known/jwks', async ({env, json}) => {
  const keyIDs = await env.KEYS.list({prefix: 'key:'})
  const keys: Key[] = (await Promise.all(keyIDs.keys.map((key) => env.KEYS.get<Key>(key.name, 'json')))).filter(
    (key): key is Key => key !== null,
  )
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

app.post('/-/generate-key', async ({env, req, json}) => {
  await authenticateAdmin(env, req)
  const key = await generateKey()
  await env.KEYS.put(`key:${key.id}`, JSON.stringify(key), {expirationTtl: keyExpirationSeconds})
  await env.KEYS.put('latest-key', key.id, {expirationTtl: keyExpirationSeconds})
  return json({ok: true})
})

app.get('/-/keys', async ({env, req, json}) => {
  await authenticateAdmin(env, req)
  const keyIDs = await env.KEYS.list({prefix: 'key:'})
  const keys: Key[] = (await Promise.all(keyIDs.keys.map((key) => env.KEYS.get<Key>(key.name, 'json')))).filter(
    (key): key is Key => key !== null,
  )
  return json(keys)
})

app.post('/-/github-session', async ({env, req, json}) => {
  await authenticateAdmin(env, req)
  const body = await req.json()
  await env.KEYS.put('github-session', body.session)
  return json({ok: true})
})
