import {
  type EventData,
  EventHubBufferedProducerClient,
  type EventHubBufferedProducerClientOptions,
  type OnSendEventsSuccessContext,
  RetryMode,
} from '@azure/event-hubs';
import { createLogger } from '@openpanel/logger';
import type { EventsQueuePayloadIncomingEvent } from './queues';

// ─── Azure Event Hubs buffered producer ─────────────────────────────────────
// Why this exists: the kafkajs producer sends one message per `send()` with
// maxInFlightRequests=1, so throughput is capped at ~1/RTT (~100/s per pod).
// Under load /track requests pile up awaiting the serialized producer and the
// pod OOMs (measured: at 10k/s offered, ~75k events stuck in memory in 8s).
//
// The buffered producer auto-batches many events per broker round-trip, so a
// single pod sustains multiple thousand/s at ~0.5s p50 with zero loss. We keep
// the existing kafkajs CONSUMER unchanged — an AMQP-produced body round-trips
// to the Kafka consumer as clean JSON as long as the body is a raw object
// (verified on the prod topic; a pre-stringified string double-encodes).

const logger = createLogger({ name: 'eventhub-producer' });

// The Azure SDK connection string. Event Hubs uses the SAME connection string for
// its Kafka and AMQP endpoints, so in prod this is ALREADY configured as the Kafka
// SASL password — we reuse it (no new env) whenever the SASL username marks an
// Event Hubs connection ($ConnectionString). EVENTHUB_CONNECTION_STRING is only an
// optional override (e.g. a dedicated send-only SAS key).
const CONNECTION_STRING =
  process.env.EVENTHUB_CONNECTION_STRING?.trim() ||
  (process.env.KAFKA_SASL_USERNAME?.trim() === '$ConnectionString'
    ? process.env.KAFKA_SASL_PASSWORD?.trim()
    : undefined);
const EVENT_HUB_NAME =
  process.env.EVENTHUB_NAME?.trim() ||
  process.env.KAFKA_EVENTS_TOPIC?.trim() ||
  'events';

// Flush cadence: the SDK sends a partition's buffer when it fills or this many
// ms elapse. ~1s keeps latency low without starving batches.
const MAX_WAIT_MS = Number.parseInt(
  process.env.EVENTHUB_MAX_WAIT_MS || '1000',
  10,
);
// Per-partition buffer bound. When full, enqueueEvent applies backpressure
// (awaits) instead of growing memory unbounded — this is the safe-failure
// property the kafkajs path lacked. ~10k * 32 partitions * ~1KiB ≈ ~320MiB cap.
const MAX_BUFFER_PER_PARTITION = Number.parseInt(
  process.env.EVENTHUB_MAX_BUFFER_PER_PARTITION || '10000',
  10,
);
// Per-attempt send-ack (and enqueue-backpressure) timeout. Sized from the
// measured /track p99 (~0.2s normal, ~1.8s worst legit spike) — NOT the ack
// stall. A normal send acks in ~200ms, so 3s is ~1.7× above the worst legit p99
// and never trips healthy traffic, while a real Event Hubs ack stall (the
// azure-sdk#17588 ~2-min bursts, which run 8-14s+) fails at 3s instead of 15s —
// 5× less time parked per request. EACH attempt gets this full budget (see the
// retry loop in produceViaEventHub): the timeout is per-attempt, not a shared
// deadline, so a retry can actually run.
const SEND_TIMEOUT_MS = Number.parseInt(
  process.env.EVENTHUB_SEND_TIMEOUT_MS || '3000',
  10,
);
// Extra send attempts on a transient (timeout / backpressure) failure. Each
// retry gets a FRESH SEND_TIMEOUT_MS, so worst-case hold ≈ (SEND_RETRIES+1) *
// SEND_TIMEOUT_MS + backoff. Safe because the consumer dedups a re-sent event on
// its __jobId / $insert_id (a slow-but-delivered send that we cut short and
// retried collapses to one row). NOTE: retries only recover a brief blip — a
// sustained stall outlasts the whole budget and still fails; the durable async
// re-produce (follow-up) is what recovers those. The concurrency cap below is
// what keeps the longer hold from piling up to an OOM at peak.
const parsedSendRetries = Number.parseInt(
  process.env.EVENTHUB_SEND_RETRIES || '3',
  10,
);
// Guard a malformed env: a NaN here must NOT collapse the attempt count to zero
// and silently stop publishing. Fall back to 3 extra attempts.
const SEND_RETRIES =
  Number.isFinite(parsedSendRetries) && parsedSendRetries >= 0
    ? parsedSendRetries
    : 3;
// Base for the exponential backoff BETWEEN in-request retries: wait ≈
// base * 2^attempt, with 50-100% jitter so a stall (which fails every in-flight
// request at once) doesn't make them all retry in lockstep — a thundering herd
// against an already-struggling broker. Kept small (100ms) on purpose: this is
// an in-REQUEST wait, so it adds directly to how long /track is held; the long
// (seconds-to-minutes) backoff belongs on the async re-produce, not here.
const SEND_RETRY_BACKOFF_MS = Number.parseInt(
  process.env.EVENTHUB_SEND_RETRY_BACKOFF_MS || '100',
  10,
);
// Load-shed valve. Worst-case in-flight ≈ offered_rate * hold, and hold grows
// with retries; at peak (~15k/s) a multi-second hold would blow past the ~75k
// in-memory events that OOM'd the old kafkajs path. Cap concurrent produces per
// pod and fail FAST past it (a quick non-2xx the client can retry) rather than
// letting the pile-up march the pod into an OOM. ~5k/pod * ~10 pods ≈ 50k < 75k.
const parsedMaxInflight = Number.parseInt(
  process.env.EVENTHUB_MAX_INFLIGHT_PRODUCES || '5000',
  10,
);
const MAX_INFLIGHT_PRODUCES =
  Number.isFinite(parsedMaxInflight) && parsedMaxInflight > 0
    ? parsedMaxInflight
    : 5000;

// SDK-level retry policy for the buffered producer's OWN background delivery —
// distinct from the in-request retry above. The buffered producer keeps trying
// to deliver an enqueued batch across this window and fires onSendEventsError
// only after it gives up; it can (and does) deliver LATE, after our short
// per-request ack timeout has already returned a 500. So a generous policy here
// means more batches that "timed out" from the request's view still land in the
// background — the event is delivered (no loss), just late — instead of being
// dropped when the SDK exhausts its retries. This is exactly Azure's documented
// guidance for EventHubBufferedProducerClient ("set a generous number of retries
// and try-timeout in RetryOptions"). It costs nothing on the hot path: /track
// still returns on the 3s ack timeout; only the background delivery is hardier.
const intEnv = (name: string, def: number): number => {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};
// The SDK's per-attempt timeout (`timeoutInMs`) has a hard 60_000ms FLOOR — any
// smaller value is clamped up to 60s — so total time the SDK keeps trying a
// batch ≈ (maxRetries + 1) × ~60s + exponential backoff. maxRetries=5 → ~6 min,
// which comfortably spans an azure-sdk#17588 ~2-min stall: a batch enqueued just
// before a stall keeps being retried in the background and lands once the broker
// recovers. `mode` must be set explicitly — the SDK default is Fixed, not
// Exponential. retryDelayInMs is the exponential base; maxRetryDelayInMs caps it.
const RETRY_MAX_RETRIES = intEnv('EVENTHUB_RETRY_MAX_RETRIES', 5);
const RETRY_DELAY_MS = intEnv('EVENTHUB_RETRY_DELAY_MS', 1000);
const RETRY_MAX_DELAY_MS = intEnv('EVENTHUB_RETRY_MAX_DELAY_MS', 30000);

export const isEventHubProducerEnabled = (): boolean =>
  Boolean(CONNECTION_STRING);

type Pending = {
  resolve: () => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

// Correlates the async send callback back to the awaiting request. Bounded by
// in-flight requests; entries are always removed (success, error, or timeout).
const pending = new Map<string, Pending>();
let seq = 0;

// Concurrent produceViaEventHub calls currently in flight in this pod, for the
// load-shed cap (MAX_INFLIGHT_PRODUCES). Incremented on entry, always
// decremented in a finally.
let inflightProduces = 0;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const settle = (
  events: OnSendEventsSuccessContext['events'],
  err: unknown,
): void => {
  for (const event of events) {
    // We only ever enqueue EventData (never AmqpAnnotatedMessage), so the
    // application-level `properties` bag carries our correlation id.
    const cid = (event as EventData).properties?.__cid;
    if (typeof cid !== 'string') {
      continue;
    }
    const p = pending.get(cid);
    if (!p) {
      continue;
    }
    pending.delete(cid);
    clearTimeout(p.timer);
    if (err) {
      p.reject(err);
    } else {
      p.resolve();
    }
  }
};

let client: EventHubBufferedProducerClient | null = null;

const getClient = (): EventHubBufferedProducerClient => {
  if (client) {
    return client;
  }
  if (!CONNECTION_STRING) {
    throw new Error(
      'No Event Hubs connection string available; set EVENTHUB_CONNECTION_STRING ' +
        'or configure KAFKA_SASL_USERNAME=$ConnectionString + KAFKA_SASL_PASSWORD',
    );
  }
  const options: EventHubBufferedProducerClientOptions = {
    maxWaitTimeInMs: MAX_WAIT_MS,
    maxEventBufferLengthPerPartition: MAX_BUFFER_PER_PARTITION,
    // Generous background retry so a transient send-ack stall is ridden out by
    // the SDK's own delivery (late but landed) rather than dropped. mode is set
    // to Exponential explicitly (SDK default is Fixed). timeoutInMs is left at
    // its 60s floor. See RETRY_* notes above.
    retryOptions: {
      mode: RetryMode.Exponential,
      maxRetries: RETRY_MAX_RETRIES,
      retryDelayInMs: RETRY_DELAY_MS,
      maxRetryDelayInMs: RETRY_MAX_DELAY_MS,
    },
    onSendEventsSuccessHandler: (ctx) => settle(ctx.events, undefined),
    onSendEventsErrorHandler: (ctx) => {
      logger.warn('eventhub batch send failed', {
        err: ctx.error?.message,
        partitionId: ctx.partitionId,
        count: ctx.events?.length,
      });
      settle(ctx.events, ctx.error ?? new Error('eventhub send failed'));
    },
  };
  // A hub-scoped connection string carries `EntityPath=<hub>` (2-arg form); a
  // namespace-scoped string needs the hub name passed separately (3-arg form).
  const hasEntityPath = /(^|;)\s*EntityPath=/i.test(CONNECTION_STRING);
  client = hasEntityPath
    ? new EventHubBufferedProducerClient(CONNECTION_STRING, options)
    : new EventHubBufferedProducerClient(
        CONNECTION_STRING,
        EVENT_HUB_NAME,
        options,
      );
  logger.info('eventhub buffered producer created', {
    eventHubName: EVENT_HUB_NAME,
    maxWaitTimeInMs: MAX_WAIT_MS,
    maxBufferPerPartition: MAX_BUFFER_PER_PARTITION,
  });
  return client;
};

// One send attempt: enqueue the event and resolve when the broker acks it (or
// reject on the given per-attempt timeout).
const attemptProduce = (
  producer: EventHubBufferedProducerClient,
  payload: EventsQueuePayloadIncomingEvent['payload'],
  partitionKey: string,
  jobId: string | undefined,
  timeoutMs: number,
): Promise<void> => {
  const cid = `${Date.now().toString(36)}-${(seq++).toString(36)}`;

  // Register the pending ack BEFORE enqueue so the send callback — which can
  // only fire after the event is buffered — always finds this entry (no race
  // where a fast send resolves before we've recorded the promise).
  const ack = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(cid);
      reject(new Error(`eventhub send ack timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(cid, { resolve, reject, timer });
  });
  // The real handler is the `await ack` below, but it isn't attached until after
  // the `enqueueEvent` await. With a very low SEND_TIMEOUT_MS the ack can reject
  // during that gap, tripping an UnhandledPromiseRejection warning for the tick
  // before we await it. This no-op keeps a handler on it at all times; the
  // `await ack` still observes and rethrows the rejection.
  ack.catch(() => {});

  // Bound the enqueue wait too: under buffer-full backpressure enqueueEvent
  // blocks, so abort it on the same deadline rather than parking the request.
  const ac = new AbortController();
  const enqueueTimer = setTimeout(
    () =>
      ac.abort(
        new Error(
          `eventhub enqueue backpressure timed out after ${timeoutMs}ms`,
        ),
      ),
    timeoutMs,
  );
  return (async () => {
    try {
      await producer.enqueueEvent(
        {
          // Body MUST be the raw object. The kafkajs consumer reads message.value
          // and JSON.parses it once; a pre-stringified string double-encodes and
          // the consumer gets a string instead of the payload (round-trip verified
          // on the prod topic). Never JSON.stringify here.
          //
          // __groupId carries the routing key INSIDE the body on purpose: Event
          // Hubs uses the AMQP partitionKey (below) only for partition routing —
          // it does NOT surface as the Kafka record key on the consumer, so the
          // consumer can't group by m.key to serialize a device's events. The
          // body round-trips reliably, so the consumer groups by __groupId instead
          // (incident 2026-08-14: keyless messages raced the session buffer).
          //
          // __jobId is the server-side dedup key. A retried produce (below, or an
          // SDK retry after a 5xx) re-sends the SAME __jobId, so the consumer
          // skips the duplicate instead of writing a second row.
          body: {
            ...payload,
            __groupId: partitionKey,
            ...(jobId ? { __jobId: jobId } : {}),
          },
          properties: { __cid: cid },
        },
        // partitionKey keeps a device's events on one partition (ordering);
        // abortSignal bounds the buffer-full backpressure wait.
        { partitionKey, abortSignal: ac.signal },
      );
    } catch (err) {
      const p = pending.get(cid);
      if (p) {
        pending.delete(cid);
        clearTimeout(p.timer);
      }
      clearTimeout(enqueueTimer);
      throw err;
    }
    // Resolve only once the batch containing this event is acked by the broker —
    // that's the durability guarantee that lets /track return 200 safely.
    try {
      return await ack;
    } finally {
      clearTimeout(enqueueTimer);
    }
  })();
};

export const produceViaEventHub = async (
  payload: EventsQueuePayloadIncomingEvent['payload'],
  partitionKey: string,
  jobId?: string,
): Promise<void> => {
  // Load-shed FIRST: if too many produces are already parked (a stall piling up
  // in-flight requests), reject fast so the pod sheds load instead of marching
  // toward an OOM (the old kafkajs path died at ~75k in-memory events). The
  // caller turns this into a quick non-2xx the client can retry later.
  if (inflightProduces >= MAX_INFLIGHT_PRODUCES) {
    logger.warn('eventhub produce shed (in-flight cap reached)', {
      inflight: inflightProduces,
      cap: MAX_INFLIGHT_PRODUCES,
    });
    throw new Error(
      `eventhub produce shed: ${inflightProduces} in-flight >= cap ${MAX_INFLIGHT_PRODUCES}`,
    );
  }

  const producer = getClient();
  inflightProduces++;
  try {
    // Retry a transient (timeout / backpressure) send failure. Each attempt gets
    // a FRESH SEND_TIMEOUT_MS — the timeout is per-ATTEMPT, not a shared deadline,
    // so a retry can actually run. (The earlier shared-deadline design could
    // never reach attempt 1: a timeout consumed the whole budget, so `remaining`
    // was 0 and the loop broke — the retry knob was dead.) Retries are safe
    // because the consumer dedups a re-sent event on its __jobId / $insert_id, so
    // a slow-but-delivered send we cut short and retried collapses to one row.
    // Worst-case hold ≈ (SEND_RETRIES+1) * SEND_TIMEOUT_MS + backoff, bounded by
    // the in-flight cap above. NOTE: these in-request retries only recover a
    // brief blip; a sustained stall outlasts the budget and still fails — the
    // durable async re-produce (follow-up) is what recovers those.
    const attempts = Math.max(1, SEND_RETRIES + 1);
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await attemptProduce(
          producer,
          payload,
          partitionKey,
          jobId,
          SEND_TIMEOUT_MS,
        );
      } catch (err) {
        lastErr = err;
        // Only retry transient timeouts / backpressure (both carry "timed out").
        // A non-transient error (auth, message-too-large, …) will just fail
        // again — fail fast instead of burning attempts on it.
        if (!(err instanceof Error && /timed out/i.test(err.message))) {
          throw err;
        }
        // Exponential backoff with 50-100% jitter before the next attempt (never
        // after the last). Jitter de-syncs the retry wave when a stall fails
        // every in-flight request at the same instant (thundering herd). Base is
        // small on purpose — this wait is IN-request, so it adds to the hold.
        if (i < attempts - 1) {
          const backoff = SEND_RETRY_BACKOFF_MS * 2 ** i;
          await sleep(backoff * (0.5 + Math.random() * 0.5));
        }
      }
    }
    logger.warn('eventhub produce failed after all retries', {
      attempts,
      err: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    throw lastErr ?? new Error('eventhub produce failed');
  } finally {
    inflightProduces--;
  }
};

export const disconnectEventHubProducer = async (): Promise<void> => {
  if (!client) {
    return;
  }
  const c = client;
  client = null;
  try {
    // Drain the in-memory buffer to the broker so a graceful shutdown doesn't
    // drop events that were enqueued-but-not-yet-sent.
    await c.flush();
  } catch (err) {
    logger.error('eventhub flush on shutdown failed', { err });
  }
  await c
    .close()
    .catch((err) => logger.error('eventhub producer close failed', { err }));
};
