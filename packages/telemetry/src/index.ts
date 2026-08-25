// Public helpers for business-code spans.
//
// The bootstrap side-effect module (packages/telemetry/bootstrap) starts the
// SDK. This file exposes ergonomic wrappers so app/worker/cron code can
// create spans without dragging @opentelemetry/api directly through every
// consumer. Anything that needs the raw API can still import it — this is
// convenience, not encapsulation.

import {
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
  type Span,
  type SpanOptions,
} from '@opentelemetry/api';

// Fixed tracer name — shows up in SigNoz as the "library" that produced
// the span. Kept stable so grouping/filtering doesn't churn on refactors.
const TRACER_NAME = 'openpanel';

export function tracer() {
  return trace.getTracer(TRACER_NAME);
}

// The current active trace id (32-hex) — useful for stamping logs and
// injecting into CH `log_comment` so span timings can be joined to
// system.query_log post-facto. Returns undefined when there is no active
// span (e.g. code path not yet instrumented, or telemetry disabled).
export function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  if (!ctx || !ctx.traceId || ctx.traceId === '00000000000000000000000000000000') {
    return undefined;
  }
  return ctx.traceId;
}

export function currentSpanId(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  if (!ctx || !ctx.spanId || ctx.spanId === '0000000000000000') {
    return undefined;
  }
  return ctx.spanId;
}

// W3C traceparent header value for the CURRENT active context, or
// undefined if there is no active trace. Callers inject this into
// out-of-process boundaries (Redis job data, Kafka payload, HTTP header)
// so the receiver can resume the same trace.
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}

// Return a context that inherits from the given traceparent, so a worker
// can bind its span under the producer's parent trace:
//
//   const ctx = contextFromTraceparent(job.data.__traceparent);
//   await context.with(ctx, () => withSpan('worker.incomingEvent', ...));
export function contextFromTraceparent(traceparent: string | undefined) {
  if (!traceparent) return context.active();
  return propagation.extract(context.active(), { traceparent });
}

export type WithSpanFn<T> = (span: Span) => Promise<T> | T;

// Async span wrapper. Records exceptions, sets status=ERROR on throw,
// always ends the span. Attributes can be passed in the options; add
// more inside the callback via `span.setAttribute(...)`.
export async function withSpan<T>(
  name: string,
  optsOrFn: (SpanOptions & { attributes?: Attributes }) | WithSpanFn<T>,
  maybeFn?: WithSpanFn<T>,
): Promise<T> {
  const fn = (typeof optsOrFn === 'function' ? optsOrFn : maybeFn) as WithSpanFn<T>;
  const opts = (typeof optsOrFn === 'function' ? {} : optsOrFn) as SpanOptions;
  return tracer().startActiveSpan(name, opts, async (span) => {
    try {
      const result = await fn(span);
      // If the callback didn't set an explicit status, leave it UNSET;
      // SigNoz treats UNSET as OK. Only setting ERROR on throw.
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

// Re-exports for callers that want lower-level access without adding
// @opentelemetry/api as a direct dep.
export { context, propagation, trace, SpanKind, SpanStatusCode };
export type { Span, SpanOptions, Attributes };
