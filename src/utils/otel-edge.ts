import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http'

interface TraceExporterConfig {
  url: string
  headers: Record<string, string>
}

/** Construct the edge exporter without merging the ambient Honeycomb header. */
export function createTraceExporter(env: NodeJS.ProcessEnv = process.env): OTLPTraceExporter {
  const config = resolveTraceEdgeExporterConfig(env)
  if (!config) return new OTLPTraceExporter()

  return createTraceExporterWithConfig(config, env)
}

export function createTraceExporterWithConfig(
  config: TraceExporterConfig,
  env: NodeJS.ProcessEnv = process.env,
): OTLPTraceExporter {
  const headerKeys = ['OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS'] as const
  const prior = headerKeys.map((key) => ({key, value: env[key]}))
  for (const key of headerKeys) delete env[key]
  try {
    return new OTLPTraceExporter(config)
  } finally {
    for (const {key, value} of prior) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
  }
}

const TRACE_EDGE_HOST = 'otel-gateway.depot.dev'

/** Use the producer-scoped edge credential only when the complete trusted configuration is present. */
export function resolveTraceEdgeExporterConfig(
  env: Record<string, string | undefined> = process.env,
): TraceExporterConfig | undefined {
  const endpoint = env.DEPOT_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  const username = env.DEPOT_OTEL_EXPORTER_OTLP_BASIC_AUTH_USERNAME
  const password = env.DEPOT_OTEL_EXPORTER_OTLP_BASIC_AUTH_PASSWORD
  if (!endpoint || !username || !password) return undefined

  try {
    const url = new URL(endpoint)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== TRACE_EDGE_HOST ||
      url.port !== '' ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search !== '' ||
      url.hash !== '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return undefined
    }
    return {
      url: `${url.origin}/v1/traces`,
      headers: {Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`},
    }
  } catch {
    return undefined
  }
}
