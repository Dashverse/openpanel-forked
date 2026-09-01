import {
  type EventData,
  EventHubBufferedProducerClient,
  type EventHubBufferedProducerClientOptions,
  type OnSendEventsSuccessContext,
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
// Fail-fast: bound both the enqueue backpressure wait and the send-ack wait so a
// broker outage returns a non-2xx quickly (client retries) instead of parking
// the HTTP request and saturating the LB — same intent as the kafkajs knobs.
const SEND_TIMEOUT_MS = Number.parseInt(
  process.env.EVENTHUB_SEND_TIMEOUT_MS || '15000',
  10,
);
// Extra send attempts on a transient failure. Retries run WITHIN the
// SEND_TIMEOUT_MS budget (see produceViaEventHub) so they never extend how long
// /track holds a request. Safe because the consumer dedups a re-sent event on
// its __jobId / $insert_id. Keep low — retries amplify produce load under a
// stall.
const parsedSendRetries = Number.parseInt(
  process.env.EVENTHUB_SEND_RETRIES || '1',
  10,
);
// Guard a malformed env: a NaN here must NOT collapse the attempt count to zero
// and silently stop publishing. Fall back to 1 extra attempt.
const SEND_RETRIES =
  Number.isFinite(parsedSendRetries) && parsedSendRetries >= 0
    ? parsedSendRetries
    : 1;

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

  // Bound the enqueue wait too: under buffer-full backpressure enqueueEvent
  // blocks, so abort it on the same deadline rather than parking the request.
  const ac = new AbortController();
  const enqueueTimer = setTimeout(
    () =>
      ac.abort(
        new Error(`eventhub enqueue backpressure timed out after ${timeoutMs}ms`),
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
  const producer = getClient();

  // Retry a transient send failure within a FIXED total budget: the sum of all
  // attempts is capped at SEND_TIMEOUT_MS, so retries never extend how long
  // /track holds the request (avoids piling up in-flight requests under a
  // stall). Retries are safe because the consumer dedups a re-sent event on its
  // __jobId / $insert_id.
  const deadline = Date.now() + SEND_TIMEOUT_MS;
  const attempts = Math.max(1, SEND_RETRIES + 1);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    const perAttempt = Math.max(1000, Math.floor(remaining / (attempts - i)));
    try {
      return await attemptProduce(
        producer,
        payload,
        partitionKey,
        jobId,
        perAttempt,
      );
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('eventhub produce failed');
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
