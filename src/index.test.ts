import assert from 'node:assert'
import {test} from 'node:test'

process.env.ADMIN_TOKEN = 'test-admin-token'

// Point DynamoDB at a closed port so a request that reaches the table fails as a server fault.
process.env.AWS_ACCESS_KEY_ID = 'test'
process.env.AWS_SECRET_ACCESS_KEY = 'test'
process.env.AWS_ENDPOINT_URL_DYNAMODB = 'http://127.0.0.1:1'
process.env.AWS_MAX_ATTEMPTS = '1'

const {app} = await import('./index')

test('answers 400 to a claim body that is not JSON', async () => {
  const response = await app.request('/claim', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: 'not json',
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {error: 'request body must be JSON'})
})

test('answers 401 to an admin request without an authorization header', async () => {
  const response = await app.request('/-/keys')

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), {error: 'missing authorization header'})
})

test('answers 401 to an admin request with a wrong token', async () => {
  const response = await app.request('/-/keys', {headers: {authorization: 'Bearer wrong-token'}})

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), {error: 'invalid token'})
})

test('keeps an unexpected storage fault at 500', async () => {
  const response = await app.request('/exchange/00000000-0000-0000-0000-000000000000', {method: 'POST'})

  assert.equal(response.status, 500)
})
