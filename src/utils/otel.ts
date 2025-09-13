import * as opentelemetry from '@opentelemetry/api'
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http'

import {NodeSDK} from '@opentelemetry/sdk-node'
import {ConsoleSpanExporter, NoopSpanProcessor} from '@opentelemetry/sdk-trace-node'

const sdk = new NodeSDK({
  traceExporter: process.env.NODE_ENV === 'production' ? new OTLPTraceExporter() : new ConsoleSpanExporter(),
  spanProcessors:
    process.env.NODE_ENV === 'production' || process.env.ENABLE_TRACING ? undefined : [new NoopSpanProcessor()],
  // Currently we do not automatically instrument this service as this creates a LOT of unused spans.
  instrumentations: [],
})

// Start tracing
sdk.start()

export async function stopTracing() {
  await sdk.shutdown()
}

export const tracer = opentelemetry.trace.getTracer(process.env.OTEL_SERVICE_NAME ?? 'actions-public-oidc')

export async function withSpan<T>(name: string, fn: (span: opentelemetry.Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn(span)
    } catch (err) {
      span.recordException(err instanceof Error ? err : `${err}`)
      span.setStatus({code: opentelemetry.SpanStatusCode.ERROR})
      throw err
    } finally {
      span.end()
    }
  })
}
