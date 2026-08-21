import {NodeTracerProvider, SimpleSpanProcessor} from '@opentelemetry/sdk-trace-node'
import assert from 'node:assert'
import {createServer} from 'node:http'
import {test} from 'node:test'
import {createTraceExporterWithConfig, resolveTraceEdgeExporterConfig} from './otel-edge'

const complete = {
  DEPOT_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://otel-gateway.depot.dev',
  DEPOT_OTEL_EXPORTER_OTLP_BASIC_AUTH_USERNAME: 'actions-public-oidc',
  DEPOT_OTEL_EXPORTER_OTLP_BASIC_AUTH_PASSWORD: 'password',
}

test('sends only Basic auth to the edge and restores ambient direct headers', async () => {
  const requests: Array<{path?: string; authorization?: string; honeycombTeam?: string}> = []
  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      honeycombTeam: request.headers['x-honeycomb-team'] as string | undefined,
    })
    request.resume()
    response.writeHead(200, {'content-type': 'application/x-protobuf'})
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const authorization = 'Basic test-credential'
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-honeycomb-team=direct-key'
  process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = 'x-extra=must-not-leak'
  try {
    const exporter = createTraceExporterWithConfig({
      url: `http://127.0.0.1:${address.port}/v1/traces`,
      headers: {Authorization: authorization},
    })
    const provider = new NodeTracerProvider({spanProcessors: [new SimpleSpanProcessor(exporter)]})
    provider.getTracer('actions-public-oidc-test').startSpan('edge.test').end()
    await provider.shutdown()

    assert.deepEqual(requests, [{path: '/v1/traces', authorization, honeycombTeam: undefined}])
    assert.equal(process.env.OTEL_EXPORTER_OTLP_HEADERS, 'x-honeycomb-team=direct-key')
    assert.equal(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS, 'x-extra=must-not-leak')
  } finally {
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test('resolves the exact OTLP/HTTP endpoint and producer credential', () => {
  assert.deepEqual(resolveTraceEdgeExporterConfig(complete), {
    url: 'https://otel-gateway.depot.dev/v1/traces',
    headers: {Authorization: `Basic ${Buffer.from('actions-public-oidc:password').toString('base64')}`},
  })
})

for (const [name, env] of Object.entries({
  incomplete: {...complete, DEPOT_OTEL_EXPORTER_OTLP_BASIC_AUTH_PASSWORD: ''},
  insecure: {...complete, DEPOT_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://otel-gateway.depot.dev'},
  untrusted: {...complete, DEPOT_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://example.com'},
  path: {...complete, DEPOT_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://otel-gateway.depot.dev/other'},
})) {
  test(`falls back to the direct exporter for ${name} configuration`, () => {
    assert.equal(resolveTraceEdgeExporterConfig(env), undefined)
  })
}
