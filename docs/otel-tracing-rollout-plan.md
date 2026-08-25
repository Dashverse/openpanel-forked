# OpenPanel — OTel Traces / Spans Rollout Plan

**Status:** DRAFT (2026-08-25) · **Owner:** Ayush · **Depends on:** existing SigNoz install in `infra/kubernetes/helm/cen/signoz.yaml`

Goal: add OpenTelemetry **traces + spans per request** to OpenPanel (`apps/api`, `apps/worker`, `apps/worker-cron`) so that one `trace_id` follows an event across every hop — HTTP `/track` → Redis/Kafka → worker → CH INSERT — and lands in SigNoz as a single flame graph. Bonus: use the same `trace_id` in ClickHouse `log_comment` so a dashboard chart trace can be joined to `system.query_log` for CH-side timings.

---

## 1. Current state (what's actually there — no fiction)

| Component | Metrics | Logs | Traces |
|---|---|---|---|
| `apps/api` (`prom-client` + Fastify metrics plugin, `/metrics`) | ✅ shipped — pino → stdout → k8s → SigNoz log ingestion | ✅ (structured pino) | ❌ **none** |
| `apps/worker` (`prom-client` on `/metrics` in `src/index.ts:52`) | ✅ shipped — buffer_* / kafka_* / job_duration_ms | ✅ pino | ❌ **none** |
| `apps/worker-cron` | ✅ (inherits `apps/worker` metrics module) | ✅ pino | ❌ **none** |
| `apps/start` (dashboard) | prom endpoint via `@hyperdx/node-opentelemetry` DEP DECLARED but **not initialized anywhere** | ✅ pino | ❌ **none** |
| `mixpanel-proxy` (`openpanel` upstream repo, not fork) | `@opentelemetry/api` imported but **no SDK** — `metrics.counter.add(...)` calls are no-ops today | ✅ | ❌ **none** |
| SigNoz install (`infra/…helm/cen/signoz.yaml`) | otel-collector present, `clickhousetraces` exporter wired, receivers accept OTLP on **4317 gRPC / 4318 HTTP**, `signozspanmetrics/delta` already emits RED (rate/error/duration) metrics from spans | already storing logs | **ready to ingest — nothing sending yet** |

**Existing scrape jobs** for OpenPanel metrics: `prometheus/openpanel-pods` in `signoz.yaml:1811-1873` (annotation-based, filters `app=openpanel-*` in `prod` ns). Same collector is what we'll target for OTLP traces — no new infra install needed.

**Key point:** SigNoz collector already speaks OTLP. What's missing is: OpenPanel services aren't producing spans and aren't shipping them to the collector.

---

## 2. What OTel spans unlock (that today's metrics don't)

**Today (metrics-only):**
- I can see `/track` p90 spiked to 2s on 2026-08-14.
- I can see `buffer_flush_duration_ms{buffer=events, phase=chInsertMs}` p95 = 3.2s the same window.
- **I cannot tell that they were caused by the same slow CH INSERT** — I'm hand-correlating clocks and hoping.

**With spans:**
- Click any slow `/track` trace in SigNoz → get the full waterfall:
  ```
  POST /track                                     1980ms  ▓▓▓▓▓▓▓▓▓▓
    ├─ parseMixpanelBatch                            2ms  ▏
    ├─ validateClient (Redis GET)                    1ms  ▏
    ├─ produceViaEventHub (enqueueEvent + ack)    1971ms  ▓▓▓▓▓▓▓▓▓▓   ← there it is
    │   └─ eventhub.enqueue                       1970ms  ▓▓▓▓▓▓▓▓▓▓
    └─ response                                      1ms
  ```
- On the same trace, follow it into the worker:
  ```
  worker.incomingEvent (trace_id abc123)          85ms  ▓▓
    ├─ enrichGeo                                   8ms
    ├─ sessionBuffer.get                          12ms
    └─ eventBuffer.rpush                           4ms
  ```
- And into `flushEvents`:
  ```
  cron.flushEvents (trace_id root — new trace)    412ms  ▓▓▓
    ├─ redis.lrange events (250 rows)              18ms
    ├─ CH.INSERT INTO events                      380ms  ▓▓▓
    │   log_comment = { flush_trace: xyz789, rows: 250 }
    └─ redis.ltrim                                 12ms
  ```
- Same `flush_trace` xyz789 goes into CH's `log_comment` → we can join `system.query_log` to spans and answer *"which flush caused the CH memory spike at 12:04?"*

**RED-metrics-for-free:** SigNoz's `signozspanmetrics/delta` (already in the collector config) turns every span into a rate/error/duration metric automatically. So spans give us metrics we didn't have to write.

---

## 3. Architecture — layered instrumentation

```
┌───────────────────────────────────────────────────────────────────┐
│ Layer 0: OTel SDK bootstrap (BEFORE app code)                     │
│   — Node --require ./otel/instrumentation.js                      │
│   — NodeSDK + OTLPTraceExporter → signoz-otel-collector:4317      │
│   — Resource: service.name, service.namespace, deployment.env, pod│
└───────────────────────────────────────────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────────────────────────────────┐
│ Layer 1: Auto-instrumentation (covers ~80% for free)              │
│   @opentelemetry/auto-instrumentations-node picks up:             │
│     ✓ http / https (inbound + outbound)                           │
│     ✓ @fastify/otel  (or fastify auto-instrumentation)            │
│     ✓ ioredis        (all Redis ops, incl. buffers)               │
│     ✓ pg / prisma    (Postgres via Prisma)                        │
│     ✓ undici         (mixpanel-proxy client)                      │
│     ✓ dns / net                                                   │
│   NOT covered automatically:                                      │
│     ✗ @clickhouse/client  (no upstream instrumentation)           │
│     ✗ @azure/event-hubs   (no upstream instrumentation)           │
│     ✗ groupmq             (fork's queue — no instrumentation)     │
│     ✗ WebSocket live routes                                       │
└───────────────────────────────────────────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────────────────────────────────┐
│ Layer 2: Manual spans on business hot paths (fork code)           │
│   HTTP handlers                                                   │
│     ✓ track.controller.handleTrack       (root span for /track)   │
│     ✓ ingestEvent (openpanel format)                              │
│     ✓ ingestMixpanel (proxy format)                               │
│   Worker jobs                                                     │
│     ✓ incomingEvent()  (per-message span, links to /track parent) │
│     ✓ sessionEnd / notification handlers                          │
│   Crons                                                           │
│     ✓ flushEvents / flushProfiles / flushSessions / flushReplays  │
│         → child span per CH INSERT with the log_comment tie       │
│   CH client wrapper                                               │
│     ✓ clix.execute() and ch.exec()  → span per query, tags:       │
│         db.system=clickhouse, db.statement (truncated), rows,     │
│         bytes, db.clickhouse.log_comment                          │
└───────────────────────────────────────────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────────────────────────────────┐
│ Layer 3: Cross-process context propagation                        │
│   HTTP → HTTP: W3C traceparent header (auto by http instr.)       │
│   HTTP → Redis (groupmq): inject traceparent into job.data        │
│                            worker extracts, sets as parent        │
│   HTTP → Kafka / Event Hubs: inject into payload.__traceparent    │
│                              consumer extracts, sets as parent    │
│   Cron flush → CH: inject trace_id into log_comment for CH-side   │
│                    join with system.query_log                     │
└───────────────────────────────────────────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────────────────────────────────┐
│ Layer 4: Sampling + cost control                                  │
│   Head-based: parentbased_traceidratio(0.05) = keep 5% of roots   │
│   Always-keep: error spans, spans > 500ms (via tail sampler)      │
│   Never-keep: /healthz, /metrics, /misc probes                    │
│   In infra: signozspanmetrics/delta stays 100% (metrics cheap,    │
│              spans expensive — the metrics layer stays lossless)  │
└───────────────────────────────────────────────────────────────────┘
```

---

## 4. Rollout — phases with PRs

### Phase 0 — SDK bootstrap + auto-instrumentation (no manual spans yet)

**Goal:** flip the switch, see traces flowing in SigNoz for HTTP + Redis + Postgres out of the box. Zero code changes to business logic.

**PR-1 (fork):** `packages/telemetry` (new package) — shared OTel bootstrap.

```
packages/telemetry/
  package.json
    "@opentelemetry/sdk-node": "^0.55"
    "@opentelemetry/auto-instrumentations-node": "^0.52"
    "@opentelemetry/exporter-trace-otlp-grpc": "^0.55"
    "@opentelemetry/resources": "^1.28"
    "@opentelemetry/semantic-conventions": "^1.28"
    "@opentelemetry/instrumentation-ioredis": "^0.46"
    "@opentelemetry/instrumentation-fastify": "^0.44"
    "@opentelemetry/instrumentation-undici": "^0.10"
    "@opentelemetry/instrumentation-pg": "^0.50"
  src/
    bootstrap.ts       — NodeSDK setup, OTLP exporter, resource detection,
                          sampler config, graceful shutdown
    index.ts           — export tracer(), withSpan(), currentTraceId()
```

Notes on why a new package (not `packages/logger`):
- `packages/logger` already declares `@hyperdx/node-opentelemetry` as a dep — it's a hosted-vendor wrapper (HyperDX cloud). We don't want to send traces to HyperDX, we want to send them to our own SigNoz. Clean separation avoids accidental double-export.
- Ship `@openpanel/telemetry` so `apps/api`, `apps/worker`, `apps/start` all reuse the same bootstrap file.

**PR-2 (fork):** wire the bootstrap into each app.

- `apps/api/src/index.ts` — first line becomes `import '@openpanel/telemetry/bootstrap';`
- `apps/worker/src/index.ts` — same
- `apps/worker-cron/src/index.ts` (if separate; else same as worker)

Alternative (equivalent): add `NODE_OPTIONS="--require @openpanel/telemetry/register"` in the Dockerfile / k8s Deployment. Easier to toggle without a code deploy.

**Env vars — required in dev + prod:**
```
OTEL_ENABLED=true                           # our guard — SDK exits early if false
OTEL_EXPORTER_OTLP_ENDPOINT=http://signoz-otel-collector.monitoring.svc.cluster.local:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_SERVICE_NAME=openpanel-api             # per service
OTEL_RESOURCE_ATTRIBUTES=service.namespace=openpanel,deployment.environment=prod
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.05                # 5% head sampling
OTEL_NODE_RESOURCE_DETECTORS=env,host,os,serviceinstance,container
```

**Verification in Phase 0:**
- SigNoz Traces tab shows `openpanel-api`, `openpanel-worker` service names.
- Click a random trace: it has HTTP spans + Redis GET/SET child spans automatically.
- No CH spans yet (that's Phase 1).
- `signozspanmetrics/delta` produces `signoz_calls_total{service_name=openpanel-api}` — free RED metrics.

**Rollout gate:** deploy to dev, watch collector memory + our pod memory for 24h. OTel SDK adds ~30-50 MB per process and CPU overhead is ~1-3%. If overhead is fine, ship to prod.

---

### Phase 1 — Manual spans on hot paths

**Goal:** cover the paths auto-instrumentation misses. Only add spans where they answer a real question.

**PR-3 (fork):** CH client wrapper spans.

- `packages/db/src/clickhouse-client.ts` — wrap `exec`, `query`, `insert` with `tracer.startActiveSpan('ch.query', ...)`.
  - Attributes: `db.system=clickhouse`, `db.statement=<first 200 chars>`, `db.clickhouse.rows_read`, `db.clickhouse.rows_written`, `db.clickhouse.log_comment` (the trace_id we send).
  - Extract server-side timing from the CH response (`x-clickhouse-summary` header) → set as span attribute.

- `packages/db/src/clickhouse/query-builder.ts` — `clix.execute()` gets the same treatment (all dashboard queries flow through this).

**PR-4 (fork):** track / ingest handler spans.

- `apps/api/src/controllers/track.controller.ts` — wrap `handleTrack`, `ingestOpenpanel`, `ingestMixpanel`. The Fastify auto-instrumentation already gives us an HTTP span; we add a child business-logic span so it shows up as a distinct row in the waterfall.

**PR-5 (fork):** buffer flush spans.

- `apps/worker-cron/src/crons/*` — each flush function gets a root span (crons are new traces, not children of a request).
- The CH INSERT inside picks up `log_comment=<span_id>` — so the buffer flush trace can be joined to `system.query_log` afterwards.
- Attributes: `openpanel.buffer=events|profiles|sessions|replay`, `openpanel.rows=250`, `openpanel.result=ok|error`.

**PR-6 (fork):** worker job spans.

- `apps/worker/src/jobs/events.groupmq-consumer.ts::incomingEvent` — wrap in a span that CONTINUES the trace from `/track` (parent extracted from `job.data.__traceparent`, see Phase 2).
- Same for `apps/worker/src/jobs/events.kafka-consumer.ts`.

---

### Phase 2 — Cross-process trace propagation

**Goal:** stop each hop from being its own disconnected trace. `POST /track` → worker → CH should be ONE trace.

**PR-7 (fork):** groupmq propagation.

- `packages/queue/src/queues.ts` — when enqueuing an event, inject W3C traceparent:
  ```ts
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  await queue.add({ ...payload, __traceparent: carrier.traceparent });
  ```
- `apps/worker/src/jobs/events.groupmq-consumer.ts` — before processing, extract:
  ```ts
  const parentCtx = propagation.extract(context.active(), { traceparent: job.data.__traceparent });
  await context.with(parentCtx, () => tracer.startActiveSpan('worker.incomingEvent', ...));
  ```

**PR-8 (fork):** Event Hubs / Kafka propagation.

- `packages/queue/src/eventhub-producer.ts::produceViaEventHub` — put traceparent in the payload body (same `__groupId` pattern):
  ```ts
  body: { ...payload, __groupId: partitionKey, __traceparent: currentTraceparent() }
  ```
- `apps/worker/src/jobs/events.kafka-consumer.ts` — extract from `payload.__traceparent`, same pattern.

**PR-9 (fork):** CH `log_comment` injection.

- Wrap `clix.execute` and raw `ch.exec` so every query sends:
  ```
  SETTINGS log_comment = '{"trace_id":"<hex>","span_id":"<hex>","endpoint":"<route>","project_id":"<uuid>"}'
  ```
- Post-facto join:
  ```sql
  SELECT
    JSONExtractString(log_comment, 'trace_id') AS trace_id,
    query, query_duration_ms, memory_usage, rows_read, exception
  FROM system.query_log
  WHERE type='QueryFinish' AND event_time > now() - 5 MINUTE
    AND log_comment != ''
  ORDER BY query_duration_ms DESC
  LIMIT 20;
  ```
  Click a slow row → paste `trace_id` in SigNoz → see the full user-side waterfall that fired that query.

---

### Phase 3 — Sampling + cost control

The one thing that will bite us if we don't design for it: **span volume**.

**Volume napkin math:**
- `/track` in prod: ~2-3k RPS peak → ~200M spans/day at 100% sampling *just for HTTP roots*. With child spans (Redis / CH / eventhub) that's easily 1-2B spans/day.
- SigNoz CH storage: each span ~1 KB after compression → 1-2 TB/day. NOT SUSTAINABLE.

**Solution — head-based sampling with an escape hatch:**

```
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.05   # keep 5% of ROOT traces (statistically representative)
```

Because it's `parentbased`, if a `/track` root is sampled-in, the worker's downstream spans on the same trace stay attached (context inherits the sampling decision). If sampled-out, the whole trace is dropped — no orphan spans.

**Always-keep overrides via a tail sampler on the collector:**

Add to `signoz.yaml` otel-collector processors (existing file — infra repo PR):

```yaml
tail_sampling:
  decision_wait: 5s
  policies:
    - name: errors
      type: status_code
      status_code: { status_codes: [ERROR] }
    - name: slow
      type: latency
      latency: { threshold_ms: 500 }
    - name: baseline-5pct
      type: probabilistic
      probabilistic: { sampling_percentage: 5 }
```

Result:
- **All errors kept** → we never miss a 5xx.
- **All slow requests kept** (>500ms) → we always catch the pathological ones.
- **5% baseline** for successful fast requests → representative sample for RED metrics.

**Never-sampled (drop at SDK level, before wire):**

```ts
// packages/telemetry/src/bootstrap.ts
const sampler = new ParentBasedSampler({
  root: new TraceIdRatioBasedSampler(0.05),
});
const filteredSampler: Sampler = {
  shouldSample(ctx, traceId, spanName, spanKind, attrs) {
    const path = attrs['http.target'] ?? attrs['http.route'];
    if (path === '/healthz' || path === '/metrics' || path === '/misc' || path === '/health') {
      return { decision: SamplingDecision.NOT_RECORD };
    }
    return sampler.shouldSample(ctx, traceId, spanName, spanKind, attrs, []);
  },
};
```

---

### Phase 4 — Dashboard + docs

**PR-10 (infra):** SigNoz saved views committed to `infra/monitoring/signoz-views/`.

Views to build (SigNoz has "Saved Views" for the Traces tab):
1. **`/track` slow requests** — service=openpanel-api, operation=/track, sort by duration desc.
2. **CH queries > 1s** — service=openpanel-api OR openpanel-worker, spanName=ch.query, duration>1s.
3. **Buffer flushes failing** — service=openpanel-worker-cron, spanName=cron.flush*, status=error.
4. **Kafka consumer slow batches** — service=openpanel-worker, spanName=kafka.consumer, duration>500ms.
5. **Trace → CH join notebook** — SigNoz "Query Builder" saved with a canned query that takes a trace_id → returns matching `system.query_log` rows.

**PR-11 (fork):** update `docs/openpanel-worker-architecture.md` + create `docs/otel-tracing.md` with:
- How to enable / disable per pod.
- How to read a trace in SigNoz.
- How to join a trace to CH `system.query_log`.
- Sampling caveats — 5% baseline, all errors kept.

---

## 5. Per-service change matrix

| Service | New file | Existing file changes | Env vars | Dockerfile |
|---|---|---|---|---|
| `apps/api` | — | `src/index.ts` (import bootstrap first), `src/controllers/track.controller.ts` (manual spans) | OTEL_* (5 vars) | none if using bootstrap import; otherwise `NODE_OPTIONS=--require @openpanel/telemetry/register` |
| `apps/worker` | — | `src/index.ts` (import bootstrap), `src/jobs/events.groupmq-consumer.ts`, `src/jobs/events.kafka-consumer.ts` (extract traceparent + startSpan) | OTEL_* | — |
| `apps/worker-cron` | — | `src/index.ts` (import bootstrap), each `src/crons/flush-*.ts` (root span per flush) | OTEL_* | — |
| `apps/start` | — | `src/entry.server.tsx` (import bootstrap — deferred; low priority since it's SSR dashboard) | OTEL_* | — |
| `packages/db` | `src/otel/ch-instrumentation.ts` (span wrapper) | `src/clickhouse-client.ts` (wire wrapper), `src/clickhouse/query-builder.ts` (wire wrapper) | — | — |
| `packages/queue` | — | `src/queues.ts` (inject traceparent on add), `src/eventhub-producer.ts` (inject on enqueue) | — | — |
| `packages/telemetry` | **entire package (new)** | — | — | — |

**Line-count estimate:** ~900 net LOC (new package ~350, ch wrapper ~150, controller/handler spans ~250, propagation wiring ~150).

---

## 6. Infra repo changes

**Minimal — SigNoz already accepts OTLP.** Two changes:

1. **`infra/kubernetes/helm/cen/signoz.yaml`** — add tail-sampling processor (see Phase 3 config block). One diff, applied via `helm upgrade`.

2. **DNS / service reachability** — confirm `signoz-otel-collector.monitoring.svc.cluster.local:4317` is reachable from `prod` namespace. It should be (same cluster) but no `NetworkPolicy` currently blocks — verify with a `kubectl run --rm -it debug --image=curlimages/curl -- curl -v signoz-otel-collector.monitoring.svc.cluster.local:4317`.

No new deployments, no new secrets (unless we add auth on the collector — currently open in-cluster).

---

## 7. Rollout order (recommended)

| Day | PR | Env | Action | Success criteria |
|---|---|---|---|---|
| 1 | PR-1 (`packages/telemetry`) | — | Ship the package. No consumer yet. | `pnpm install` succeeds, TS compiles. |
| 2 | PR-2 (wire bootstrap into api + worker) | **dev** | `OTEL_ENABLED=true` in dev configmap, restart pods. | Traces appear in SigNoz for `openpanel-api-dev`, `openpanel-worker-dev`. HTTP + Redis spans visible. Pod mem +30-50 MB. |
| 3 | Phase-0 baseline observation | dev | Let it run 24h. | No pod restarts, no collector OOM, span rate as expected. |
| 4 | PR-2 to **prod** | prod | Configmap flip + rolling restart. Start at `OTEL_TRACES_SAMPLER_ARG=0.01` (1%). | Prod traces flowing, no perf regression on /track p90. |
| 5 | PR-3 (CH client spans) | dev → prod | Same rollout. | `ch.query` spans visible in every trace touching CH. |
| 6 | PR-4 + PR-5 (business spans) | dev → prod | | Waterfalls now show meaningful business steps. |
| 7 | PR-7 + PR-8 (cross-process propagation) | dev → prod | | A `/track` trace continues into the worker consumer — verify visually in SigNoz. |
| 8 | PR-9 (log_comment) | dev → prod | | Run join query — every trace's CH work is queryable in `system.query_log`. |
| 9 | Infra PR (tail sampler) | monitoring ns | `helm upgrade signoz`. | Drop rate matches design (errors + slow always kept). |
| 10 | Bump sample rate 1% → 5% | prod | Configmap flip. | Volume increases 5x — check CH storage headroom in SigNoz CH. |

---

## 8. Rollback plan

Every step is env-toggleable:

- **Nuclear:** `OTEL_ENABLED=false` in configmap + restart. SDK exits early in `bootstrap.ts`, zero overhead.
- **Reduce sample rate:** `OTEL_TRACES_SAMPLER_ARG=0.001` — 99.9% dropped, still see errors.
- **Per-service disable:** only flip on the misbehaving service's Deployment.
- **Collector overload:** ratchet the tail sampler `sampling_percentage` down or bump collector replicas.

The bootstrap MUST fail-closed on any exporter error (never crash the app):
```ts
// bootstrap.ts
try { sdk.start(); } catch (e) { console.error('OTel init failed', e); }
```

---

## 9. Cost estimate (SigNoz-side)

Assuming production `/track` at ~2k RPS after sampling:

| Layer | Volume | CH storage/day |
|---|---|---|
| HTTP roots @ 5% | ~100 traces/s × 86400 = 8.6M traces/day | ~1-2 GB |
| Full trace (avg 8 spans) | 8.6M × 8 = 69M spans/day | ~10-20 GB |
| Metrics from spans (RED) | continuous but small | ~500 MB |
| Tail-kept errors + slow | ~1% extra | ~500 MB |
| **Total** | | **~15-25 GB/day** |

SigNoz `clickhousetraces` uses TTL. Set `TTL=7 days` for signoz_traces DB → ~150 GB rolling. Manageable on the existing SigNoz CH.

Compare: metrics today are ~2 GB/day. Traces at 5% add ~15-25 GB/day → **~10x storage bump** but still small in absolute terms.

---

## 10. Open questions

1. **Do we ever want 100% sampling on a specific `project_id`?** e.g. "trace every Frameo /track for the next hour to debug." → We can add a header-triggered override sampler (`x-debug-trace: 1` → always keep) as a follow-up PR.

2. **Postgres via Prisma** — auto-instrumentation gives us `pg` spans but Prisma has its own OTel plugin (`@prisma/instrumentation`). Include from day 1 or defer? → Include, cheap.

3. **`packages/db` clix.execute vs raw ch.exec** — some code paths bypass clix. We wrap the CH client itself (not just clix) so both are covered.

4. **`groupmq` (fork's queue) internals** — auto-instrumentation won't cover it (custom code). Manual spans in the consumer only, or wrap groupmq's `add`/`process` methods generically in `packages/queue`? → Generic wrap in `packages/queue`.

5. **Log correlation** — pino logs today have no trace_id. Small pino formatter change to inject `{ trace_id, span_id }` from `context.active()` → SigNoz can then click a log → jump to the trace. Add to PR-2. Not blocking.

6. **`apps/start` dashboard** — do we trace the SSR side too? Value is real (debug "why is this chart slow"), but it's Layer-2-of-Layer-1 work — defer to a follow-up PR after api/worker are stable.

7. **Existing `@hyperdx/node-opentelemetry` in `apps/start` and `packages/logger`** — currently dormant (not imported). Should we remove them? → Yes, in a cleanup PR, once we've confirmed our own SDK is what's live. Leaving them can cause double-export confusion.

---

## 11. What this does NOT do

- **Does not** add trace-based alerting (SigNoz alerts on metrics; spans feed RED metrics, so alerts still work — but no "alert when trace has 3+ failed spans").
- **Does not** replace existing prom-client metrics — those stay. Traces are additive.
- **Does not** trace inside `mixpanel-proxy` (that's a different repo — separate PR). Once shipped there, its outbound `/track` calls will continue our trace into openpanel-api.
- **Does not** capture full request/response bodies as span attributes (privacy + cost). Only structural fields (path, method, status, size).

---

## 12. Prior art / references

- **PostHog** (open-source competitor, Django + Python): uses OpenTelemetry with `@opentelemetry/instrumentation-django` + custom CH query middleware; ships to SigNoz internally. Their CH client wrapper is at `posthog/clickhouse/client.py` — inserts `SETTINGS log_comment` per query, same pattern we're planning.
- **Grafana Tempo docs** — head vs tail sampling trade-offs.
- **OpenTelemetry Node.js SDK docs** — `parentbased_traceidratio` is the recommended default sampler.
- **SigNoz `signozspanmetrics/delta` processor** — already in our collector config; gives us RED metrics from spans automatically, no code changes.

---

## 13. Decision checklist (before implementing)

- [ ] Confirm SigNoz CH has 150 GB headroom for 7-day trace TTL.
- [ ] Confirm `signoz-otel-collector.monitoring.svc.cluster.local:4317` reachable from `prod` namespace.
- [ ] Decide: `NODE_OPTIONS=--require` vs code-level bootstrap import. (Recommend: import — lockstep with app code, easier to reason about in dev.)
- [ ] Decide starting sample rate — recommend 1% for the first prod week, then 5%.
- [ ] Sign-off on the `packages/telemetry` addition to the workspace.
