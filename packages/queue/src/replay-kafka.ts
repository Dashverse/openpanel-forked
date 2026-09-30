/// <reference path="./lz4js.d.ts" />
import type { IClickhouseSessionReplayChunk } from '@openpanel/db';
import { currentTraceparent } from '@openpanel/telemetry';
import type { Consumer, Producer } from 'kafkajs';
import * as lz4 from 'lz4js';
import { getKafka, isKafkaConfigured, kafkaLogger } from './kafka';

// Dedicated Kafka path for SESSION REPLAY chunks — separate from the events
// path (which produces via the Azure Event Hubs AMQP buffered producer). Replay
// uses a real kafkajs PRODUCER because (a) it surfaces the message key to the
// consumer natively (unlike the AMQP m.key gap), and (b) it works against both
// Redpanda-local (dev) and the Event Hubs Kafka endpoint (prod). Replay volume
// is low (~2/s) so the #414 kafkajs-producer OOM (a high-throughput, mif-pileup
// failure) doesn't apply; we still cap in-flight requests to be safe.
//
// Redis-free: there is NO fallback buffer on this path. A produce failure throws
// so /track errors and the SDK retries; a chunk still >1 MB after LZ4 is dropped
// (usually a fat full snapshot), counted by the caller, not shipped.

export const KAFKA_REPLAY_TOPIC =
  process.env.KAFKA_REPLAY_TOPIC || 'session-replay';
export const KAFKA_REPLAY_CONSUMER_GROUP =
  process.env.KAFKA_REPLAY_CONSUMER_GROUP || 'openpanel-replay';

// Max COMPRESSED message value we will produce. Event Hubs Standard caps a
// message (key + value + headers) at ~1 MB; leave headroom. A chunk over this
// after LZ4 is dropped by the caller (`produceReplayChunk` returns 'oversize').
export const REPLAY_KAFKA_MAX_BYTES = Number.parseInt(
  process.env.REPLAY_KAFKA_MAX_BYTES || '950000',
  10,
);
const REPLAY_KAFKA_MAX_INFLIGHT = Number.parseInt(
  process.env.REPLAY_KAFKA_MAX_INFLIGHT || '5',
  10,
);
const REPLAY_KAFKA_PRODUCER_RETRIES = Number.parseInt(
  process.env.REPLAY_KAFKA_PRODUCER_RETRIES || '3',
  10,
);
const REPLAY_KAFKA_MAX_BYTES_PER_PARTITION = Number.parseInt(
  process.env.KAFKA_REPLAY_MAX_BYTES_PER_PARTITION || String(5 * 1024 * 1024),
  10,
);

// Admission cap on concurrent in-flight produceReplayChunk calls. maxInFlight-
// Requests only bounds concurrent BROKER requests — KafkaJS queues the overflow
// in an UNCAPPED pending queue, and every awaiting /track handler retains its
// compressed payload (up to REPLAY_KAFKA_MAX_BYTES ≈ 950 KB) meanwhile. So a
// slow/stalled broker could pile fat payloads and OOM the API (cf. the events
// #414 producer OOM). When the cap is hit we reject IMMEDIATELY (before
// serialize+compress) so /track returns a retryable error rather than retaining
// yet another payload. Tunable; 0 disables the cap.
const REPLAY_KAFKA_MAX_CONCURRENT_PRODUCES = Number.parseInt(
  process.env.REPLAY_KAFKA_MAX_CONCURRENT_PRODUCES || '200',
  10,
);
let inFlightProduces = 0;

// ─── per-project rollout gate (mirrors shouldUseKafka in kafka.ts) ──────────
// Empty = every replay-enabled project stays on the legacy Redis buffer. Add
// project ids (or `*`) to move them onto Kafka. Flip via kubectl set env +
// rollout. Separate from REPLAY_ENABLED_PROJECT_IDS (which gates whether replay
// is recorded at all).
const replayKafkaProjectIdsEnv = (
  process.env.REPLAY_KAFKA_PROJECT_IDS || ''
).trim();
const replayKafkaAllowAll = replayKafkaProjectIdsEnv === '*';
const replayKafkaAllowList = new Set<string>(
  replayKafkaProjectIdsEnv && !replayKafkaAllowAll
    ? replayKafkaProjectIdsEnv
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    : [],
);

export const shouldUseReplayKafka = (projectId: string): boolean => {
  if (!isKafkaConfigured()) {
    return false;
  }
  if (replayKafkaAllowAll) {
    return true;
  }
  return replayKafkaAllowList.has(projectId);
};

// ─── LZ4 (self-describing frame format) ─────────────────────────────────────
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** LZ4-compress a JSONEachRow line to the wire value. */
export const compressReplayLine = (line: string): Buffer =>
  Buffer.from(lz4.compress(textEncoder.encode(line)));

/** Reverse `compressReplayLine` on the consumer side. */
export const decompressReplayLine = (value: Uint8Array): string =>
  textDecoder.decode(lz4.decompress(value));

// ─── producer (bounded, replay-only) ────────────────────────────────────────
let producer: Producer | null = null;
let producerConnect: Promise<void> | null = null;

const getReplayProducer = async (): Promise<Producer> => {
  if (!producer) {
    producer = getKafka().producer({
      allowAutoTopicCreation: false,
      idempotent: false,
      // Bound concurrent in-flight sends so a slow broker backpressures the
      // (low-rate) /track path instead of piling up in memory.
      maxInFlightRequests: REPLAY_KAFKA_MAX_INFLIGHT,
      retry: { retries: REPLAY_KAFKA_PRODUCER_RETRIES },
    });
  }
  if (!producerConnect) {
    producerConnect = producer.connect().catch((err) => {
      // Allow a reconnect attempt on the next call rather than latching failed.
      producerConnect = null;
      throw err;
    });
  }
  await producerConnect;
  return producer;
};

export type ReplayProduceResult = 'produced' | 'oversize';

/**
 * Produce one replay chunk to the replay topic. Partition key = `deviceId` so a
 * session's chunks stay ordered on one partition. Value = LZ4(JSONEachRow line).
 * Returns `'oversize'` (caller drops + counts) when the compressed value exceeds
 * the cap; THROWS on an unrecoverable send failure so /track errors → SDK retry.
 */
export const produceReplayChunk = async (
  chunk: IClickhouseSessionReplayChunk,
  deviceId: string,
): Promise<ReplayProduceResult> => {
  // Reject before spending CPU on serialize+compress when too many chunks are
  // already in flight (bounds retained fat payloads under a broker stall).
  if (
    REPLAY_KAFKA_MAX_CONCURRENT_PRODUCES > 0 &&
    inFlightProduces >= REPLAY_KAFKA_MAX_CONCURRENT_PRODUCES
  ) {
    throw new Error(
      `replay produce backpressure: ${inFlightProduces} in-flight >= cap ${REPLAY_KAFKA_MAX_CONCURRENT_PRODUCES}`,
    );
  }
  inFlightProduces++;
  try {
    const line = JSON.stringify(chunk);
    const value = compressReplayLine(line);
    if (value.length > REPLAY_KAFKA_MAX_BYTES) {
      return 'oversize';
    }
    const headers: Record<string, string> = { 'content-encoding': 'lz4' };
    const tp = currentTraceparent();
    if (tp) {
      headers.traceparent = tp;
    }
    const p = await getReplayProducer();
    await p.send({
      topic: KAFKA_REPLAY_TOPIC,
      messages: [{ key: deviceId, value, headers }],
    });
    return 'produced';
  } finally {
    inFlightProduces--;
  }
};

// ─── consumer factory ───────────────────────────────────────────────────────
const replayConsumers = new Set<Consumer>();

export const createKafkaReplayConsumer = (options?: {
  groupId?: string;
}): Consumer => {
  const consumer = getKafka().consumer({
    groupId: options?.groupId || KAFKA_REPLAY_CONSUMER_GROUP,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
    // Replay messages are ~KB–MB each (events are ~1 KB) → allow a larger fetch.
    maxBytesPerPartition: REPLAY_KAFKA_MAX_BYTES_PER_PARTITION,
    maxWaitTimeInMs: 500,
  });
  replayConsumers.add(consumer);
  return consumer;
};

export const disconnectReplayKafka = async (): Promise<void> => {
  const tasks: Promise<unknown>[] = [];
  if (producer) {
    tasks.push(
      producer.disconnect().catch((err) => {
        kafkaLogger.error('replay producer disconnect error', { err });
      }),
    );
  }
  for (const c of replayConsumers) {
    tasks.push(
      c.disconnect().catch((err) => {
        kafkaLogger.error('replay consumer disconnect error', { err });
      }),
    );
  }
  replayConsumers.clear();
  producer = null;
  producerConnect = null;
  await Promise.all(tasks);
};
