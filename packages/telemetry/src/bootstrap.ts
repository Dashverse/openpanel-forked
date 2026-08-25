// OpenTelemetry SDK bootstrap for OpenPanel Node services.
//
// Called once per process, BEFORE any instrumented modules (http, ioredis,
// undici, pg, etc.) are loaded — the auto-instrumentations patch them at
// module-load time, so ordering matters. In apps that import this file at
// the top of their entry, ESM hoists the bare import above all others.
//
// Fail-closed on any init error: log and continue. A broken exporter must
// never crash the app; the app should always run without traces.
//
// All non-api OTel primitives are imported through the `sdk-node` package
// namespaces (`core`, `resources`, `tracing`). This is deliberate: the
// workspace has multiple OTel versions installed (hyperdx pulls an older
// tree), and reaching for them via sdk-node guarantees we use the ones
// sdk-node itself is built against, avoiding cross-version type mismatch.

import {
  DiagConsoleLogger,
  DiagLogLevel,
  diag,
  type Attributes,
  type Context,
  type Link,
  type SpanKind,
} from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { NodeSDK, core, resources, tracing } from '@opentelemetry/sdk-node';

// The env var we use to gate ALL OTel init. Read at module top so the app
// pays zero cost when disabled — no SDK instance, no exporter, no patches.
const OTEL_ENABLED = process.env.OTEL_ENABLED === 'true';

// Paths we NEVER want traces for — health probes and metric scrapes fire
// dozens of times per minute per pod and add noise without diagnostic
// value. Dropped at the SDK level so they never hit the wire.
const IGNORED_PATHS = new Set([
  '/healthcheck',
  '/healthz',
  '/health',
  '/liveness',
  '/readiness',
  '/metrics',
  '/misc',
  '/favicon.ico',
]);

// Wraps the parent-based ratio sampler so health/metrics paths are dropped
// unconditionally BEFORE any sampling decision. Prod /metrics is scraped
// every 15s per pod — that alone would dominate span volume.
function makeSampler(ratio: number): tracing.Sampler {
  const inner = new core.ParentBasedSampler({
    root: new core.TraceIdRatioBasedSampler(ratio),
  });
  return {
    shouldSample(
      ctx: Context,
      traceId: string,
      spanName: string,
      spanKind: SpanKind,
      attributes: Attributes,
      links: Link[],
    ): tracing.SamplingResult {
      const path =
        (attributes['http.target'] as string | undefined) ??
        (attributes['http.route'] as string | undefined) ??
        (attributes['url.path'] as string | undefined);
      if (path && IGNORED_PATHS.has(path)) {
        return { decision: tracing.SamplingDecision.NOT_RECORD };
      }
      return inner.shouldSample(ctx, traceId, spanName, spanKind, attributes, links);
    },
    toString(): string {
      return `IgnorePathsSampler(inner=${inner.toString()})`;
    },
  };
}

let sdk: NodeSDK | undefined;

export function startTelemetry(): void {
  if (!OTEL_ENABLED) {
    return;
  }
  if (sdk) {
    // Idempotent — bootstrap can be imported twice in test harnesses.
    return;
  }

  // OTel's own diag logger. Default ERROR so a normal boot stays quiet;
  // OTEL_LOG_LEVEL=debug flips it on for wire-level debugging.
  const diagLevel = (process.env.OTEL_LOG_LEVEL ?? 'error').toUpperCase();
  const levelMap: Record<string, DiagLogLevel> = {
    NONE: DiagLogLevel.NONE,
    ERROR: DiagLogLevel.ERROR,
    WARN: DiagLogLevel.WARN,
    INFO: DiagLogLevel.INFO,
    DEBUG: DiagLogLevel.DEBUG,
    VERBOSE: DiagLogLevel.VERBOSE,
    ALL: DiagLogLevel.ALL,
  };
  diag.setLogger(new DiagConsoleLogger(), levelMap[diagLevel] ?? DiagLogLevel.ERROR);

  // service.name / namespace / version / env — SigNoz groups traces by these.
  // OTEL_SERVICE_NAME is honored by the SDK automatically; we set the rest
  // explicitly so a pod restart with a new IMAGE_TAG shows the new version.
  // Attribute keys are string literals (rather than semconv constants) to
  // stay portable across semconv package versions — the wire values are
  // what matters, and these are the stable OpenTelemetry keys.
  const resource = new resources.Resource({
    'service.name': process.env.OTEL_SERVICE_NAME ?? 'openpanel-unknown',
    'service.namespace': process.env.OTEL_SERVICE_NAMESPACE ?? 'openpanel',
    'service.version': process.env.IMAGE_TAG ?? process.env.APP_VERSION ?? 'dev',
    'deployment.environment': process.env.NODE_ENV ?? 'development',
    'k8s.pod.name': process.env.POD_NAME ?? process.env.HOSTNAME ?? 'unknown',
    'k8s.namespace.name': process.env.POD_NAMESPACE ?? 'unknown',
  });

  // Default: keep every trace. We want full visibility during rollout;
  // if span volume becomes a problem later, dial down via env
  // (OTEL_TRACES_SAMPLER_ARG=0.05 = 5% head sampling).
  const sampleRatio = Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? '1.0');

  // OTLP HTTP/proto (port 4318 by default on SigNoz otel-collector).
  // We prefer proto over grpc: no @grpc/grpc-js native binary dep, and the
  // perf difference is negligible for our span volume. Endpoint defaults
  // to the in-cluster SigNoz collector; override for local via env.
  const exporter = new OTLPTraceExporter({
    url:
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
      (process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`
        : 'http://signoz-otel-collector.monitoring.svc.cluster.local:4318/v1/traces'),
  });

  // Batch settings: SDK defaults are fine for our volume. Called out here
  // so a future incident (collector overload) has one obvious knob to turn.
  const spanProcessor = new tracing.BatchSpanProcessor(exporter, {
    // Flush at least every 5s so a low-traffic pod's spans don't sit for minutes.
    scheduledDelayMillis: 5000,
    // Cap in-memory buffer so a collector outage doesn't OOM the pod.
    maxQueueSize: 4096,
    maxExportBatchSize: 512,
    exportTimeoutMillis: 15000,
  });

  try {
    sdk = new NodeSDK({
      resource,
      spanProcessor,
      sampler: makeSampler(Number.isFinite(sampleRatio) ? sampleRatio : 0.05),
      textMapPropagator: new core.W3CTraceContextPropagator(),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Filesystem instrumentation is extremely noisy (every fs.read
          // is a span) and adds no value for us. Off.
          '@opentelemetry/instrumentation-fs': { enabled: false },
          // DNS same story.
          '@opentelemetry/instrumentation-dns': { enabled: false },
          // Redis auto-instrumentation is helpful but verbose. Keep it
          // enabled; sampling bounds the cost.
          '@opentelemetry/instrumentation-ioredis': {
            requireParentSpan: false,
          },
        }),
      ],
    });
    sdk.start();

    // Graceful shutdown — flush pending spans on SIGTERM/SIGINT before
    // the process exits, so the last few seconds of traces aren't lost.
    const shutdown = async () => {
      try {
        await sdk?.shutdown();
      } catch (err) {
        console.error('[telemetry] shutdown failed', err);
      }
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    process.once('beforeExit', shutdown);
  } catch (err) {
    // Fail-closed: log and continue. The app runs fine without traces;
    // it must NOT crash because the exporter can't reach the collector.
    console.error('[telemetry] init failed — running without traces', err);
    sdk = undefined;
  }
}

export function isTelemetryEnabled(): boolean {
  return OTEL_ENABLED && sdk !== undefined;
}

// Side-effect: importing this file starts the SDK. Consumers do:
//   import '@openpanel/telemetry/bootstrap';
// as the very first line of their entry module.
startTelemetry();
