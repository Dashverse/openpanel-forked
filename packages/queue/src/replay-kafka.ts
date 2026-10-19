/// <reference path="./lz4js.d.ts" />
import type { IClickhouseSessionReplayChunk } from '@openpanel/db';
import { currentTraceparent } from '@openpanel/telemetry';
import { randomUUID } from 'node:crypto';
import * as zlib from 'node:zlib';
import type { Consumer, Producer } from 'kafkajs';
import * as lz4 from 'lz4js';
import { getKafka, isKafkaConfigured, kafkaLogger } from './kafka';
import {
  REPLAY_CHUNK_ID_HEADER,
  REPLAY_KAFKA_MAX_PARTS,
  REPLAY_PARTS_HEADER,
  REPLAY_PART_HEADER,
  splitReplayValue,
} from './replay-parts';

// Dedicated Kafka path for SESSION REPLAY chunks — separate from the events
// path (which produces via the Azure Event Hubs AMQP buffered producer). Replay
// uses a real kafkajs PRODUCER because (a) it surfaces the message key to the
// consumer natively (unlike the AMQP m.key gap), and (b) it works against both
// Redpanda-local (dev) and the Event Hubs Kafka endpoint (prod). Replay volume
// is low (~2/s) so the #414 kafkajs-producer OOM (a high-throughput, mif-pileup
// failure) doesn't apply; we still cap in-flight requests to be safe.
//
// Redis-free: there is NO fallback buffer on this path. A produce failure throws
// so /track errors and the SDK retries. A chunk still >1 MB compressed (usually
// a fat full snapshot) is split into transport parts (see replay-parts.ts) up
// to REPLAY_KAFKA_MAX_TOTAL_BYTES; only above that is it dropped, counted by
// the caller, not shipped.

export const KAFKA_REPLAY_TOPIC =
  process.env.KAFKA_REPLAY_TOPIC || 'session-replay';
export const KAFKA_REPLAY_CONSUMER_GROUP =
  process.env.KAFKA_REPLAY_CONSUMER_GROUP || 'openpanel-replay';

// Max COMPRESSED message value we will produce. Event Hubs Standard caps a
// message (key + value + headers) at ~1 MB; leave headroom. A chunk over this
// compressed is sent as several parts of at most this size each.
export const REPLAY_KAFKA_MAX_BYTES = Number.parseInt(
  process.env.REPLAY_KAFKA_MAX_BYTES || '950000',
  10,
);
// Consumer fetch size per partition, and from it the split cap. Unchanged
// from before splitting (5 MiB; kafkajs' own default is 1 MB), so turning the
// split on or off never changes the worker's fetch. A part set is only
// reassembled when ALL its parts arrive in one partition batch, so the largest
// chunk we split is the fetch size minus room for two max-size messages of
// other sessions interleaved between its parts: 5 MiB - 2 x 950000 = ~3.3 MB.
// Set KAFKA_REPLAY_MAX_BYTES_PER_PARTITION to the same value on the API and the
// worker; the API derives its cap from it.
export const REPLAY_KAFKA_MAX_BYTES_PER_PARTITION = Number.parseInt(
  process.env.KAFKA_REPLAY_MAX_BYTES_PER_PARTITION || String(5 * 1024 * 1024),
  10,
);
// Whole-fetch cap across partitions. Before this change it was not set, i.e.
// kafkajs' default of 10 MB (10485760), which still holds two full partition
// batches; kept as the default and never below one partition's fetch. Peak
// consumer memory is about one fetch response plus one partition batch's
// decompressed lines (replay JSON decompresses ~5-11x).
const REPLAY_KAFKA_FETCH_MAX_BYTES = Math.max(
  Number.parseInt(
    process.env.KAFKA_REPLAY_FETCH_MAX_BYTES || String(10 * 1024 * 1024),
    10,
  ),
  REPLAY_KAFKA_MAX_BYTES_PER_PARTITION,
);
// Max total COMPRESSED size of one chunk sent as parts; above it the chunk is
// dropped by the caller (`produceReplayChunk` returns 'oversize'). Defaults to
// the most a fetch can carry (above); a larger REPLAY_KAFKA_MAX_TOTAL_BYTES is
// clamped to it with a warning, since such a set could never be reassembled.
const REPLAY_KAFKA_FETCHABLE_TOTAL_BYTES = Math.max(
  0,
  REPLAY_KAFKA_MAX_BYTES_PER_PARTITION - 2 * REPLAY_KAFKA_MAX_BYTES,
);
export const REPLAY_KAFKA_MAX_TOTAL_BYTES = ((): number => {
  const raw = process.env.REPLAY_KAFKA_MAX_TOTAL_BYTES;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) {
    return REPLAY_KAFKA_FETCHABLE_TOTAL_BYTES;
  }
  if (n > REPLAY_KAFKA_FETCHABLE_TOTAL_BYTES) {
    kafkaLogger.warn(
      'REPLAY_KAFKA_MAX_TOTAL_BYTES is above what one consumer fetch can hold; clamped',
      {
        requested: n,
        clampedTo: REPLAY_KAFKA_FETCHABLE_TOTAL_BYTES,
        maxBytesPerPartition: REPLAY_KAFKA_MAX_BYTES_PER_PARTITION,
      },
    );
    return REPLAY_KAFKA_FETCHABLE_TOTAL_BYTES;
  }
  return n;
})();
// Kill switch for splitting, OFF by default. A worker without the reassembly
// code decodes a lone part 0 into a truncated line WITHOUT an error (lz4js
// returns what it has), whose CH insert then fails on every redelivery and
// stalls the partition. So: deploy the worker first, then set
// REPLAY_KAFKA_SPLIT_ENABLED=1 on the API. Off = over-limit chunks are dropped
// as 'oversize' exactly as before.
const REPLAY_KAFKA_SPLIT_ENABLED = ['1', 'true'].includes(
  (process.env.REPLAY_KAFKA_SPLIT_ENABLED || '').trim().toLowerCase(),
);
// A part set must be fully produced within this long of its first part, or the
// rest is not sent (throws -> SDK retries the chunk under a new chunk id). The
// worker treats a set as abandoned once it sees messages produced well after
// it (REPLAY_KAFKA_PARTS_ABANDON_MS, default 120s), which must stay above this
// plus one send's retry budget (~25s with the defaults).
const REPLAY_KAFKA_PARTS_DEADLINE_MS = Number.parseInt(
  process.env.REPLAY_KAFKA_PARTS_DEADLINE_MS || '30000',
  10,
);
// Admission cap on the compressed bytes held by in-flight multi-part sends. A
// split chunk is several times a normal one and is sent in several round
// trips, so the count cap below alone would let a broker stall retain up to
// 200 x the total cap. Over the cap we reject (backpressure, the SDK retries).
const REPLAY_KAFKA_MAX_INFLIGHT_PART_BYTES = Number.parseInt(
  process.env.REPLAY_KAFKA_MAX_INFLIGHT_PART_BYTES || String(64 * 1024 * 1024),
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
let inFlightPartBytes = 0;

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

// ─── codec switch (REPLAY_KAFKA_CODEC = lz4 | zstd) ─────────────────────────
// zstd level 3 is ~45% smaller than lz4js on large replay chunks and faster in
// both directions (native vs pure JS; see scripts/bench-replay-compression.ts),
// so fewer chunks need splitting at all. Same node:zlib codec the Blob blocks
// use (packages/db/src/blob/replay-blocks.ts). The header carries the codec;
// consumers fall back to the frame magic when it is missing, so the worker
// reads both and must be deployed BEFORE the API flips to zstd (an older
// worker LZ4-decodes everything and would drop zstd chunks as undecodable).
export type ReplayCodec = 'lz4' | 'zstd';

// zstd landed in node:zlib in Node 22.15; guard so an older runtime keeps
// working on LZ4 instead of crashing every /track replay call.
export const isZstdAvailable = (): boolean =>
  typeof zlib.zstdCompressSync === 'function' &&
  typeof zlib.zstdDecompressSync === 'function';

const ZSTD_LEVEL = 3;

const REPLAY_KAFKA_CODEC: ReplayCodec = ((): ReplayCodec => {
  const v = (process.env.REPLAY_KAFKA_CODEC || 'lz4').trim().toLowerCase();
  if (v === 'zstd') {
    if (!isZstdAvailable()) {
      kafkaLogger.warn(
        'REPLAY_KAFKA_CODEC=zstd but node:zlib has no zstd on this runtime; using lz4',
      );
      return 'lz4';
    }
    return 'zstd';
  }
  if (v !== 'lz4') {
    kafkaLogger.warn('Unsupported REPLAY_KAFKA_CODEC; using lz4', { value: v });
  }
  return 'lz4';
})();

/** Compress a JSONEachRow line with `codec` (default: REPLAY_KAFKA_CODEC). */
export const encodeReplayLine = (
  line: string,
  codec: ReplayCodec = REPLAY_KAFKA_CODEC,
): Buffer =>
  codec === 'zstd'
    ? zlib.zstdCompressSync(Buffer.from(line, 'utf8'), {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
      })
    : compressReplayLine(line);

/** Codec from a value's frame magic: zstd 28 B5 2F FD, LZ4 04 22 4D 18. */
export const detectReplayCodec = (value: Uint8Array): ReplayCodec | null => {
  if (value.length < 4) return null;
  if (
    value[0] === 0x28 &&
    value[1] === 0xb5 &&
    value[2] === 0x2f &&
    value[3] === 0xfd
  ) {
    return 'zstd';
  }
  if (
    value[0] === 0x04 &&
    value[1] === 0x22 &&
    value[2] === 0x4d &&
    value[3] === 0x18
  ) {
    return 'lz4';
  }
  return null;
};

/**
 * Consumer-side decode of a replay value (for a split chunk: the joined
 * bytes). Uses the content-encoding header, else the frame magic; throws on an
 * unknown codec (the consumer drops + logs such a message).
 */
export const decodeReplayValue = (
  value: Uint8Array,
  contentEncoding?: string,
): string => {
  const header = contentEncoding?.trim().toLowerCase();
  const codec =
    header === 'zstd' || header === 'lz4' ? header : detectReplayCodec(value);
  if (codec === 'zstd') {
    return textDecoder.decode(zlib.zstdDecompressSync(value));
  }
  if (codec === 'lz4') {
    return decompressReplayLine(value);
  }
  throw new Error(
    `unknown replay content-encoding: ${header ?? 'none'} (no known frame magic)`,
  );
};

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

export type ReplayProduceStatus = 'produced' | 'oversize';

export interface ReplayProduceResult {
  status: ReplayProduceStatus;
  /** Compressed value size (the whole chunk, before any split). */
  compressedBytes: number;
  /** Messages sent: 1 for a normal chunk, N for a split one, 0 when oversize. */
  parts: number;
}

/**
 * Produce one replay chunk to the replay topic. Partition key = `key` (the
 * caller passes the sessionId) so a session's chunks stay on one partition.
 * Value = LZ4 or zstd (REPLAY_KAFKA_CODEC) of the JSONEachRow line, with the
 * codec in the content-encoding header; over REPLAY_KAFKA_MAX_BYTES it is
 * sent as parts. Returns status `'oversize'` (caller drops + counts) when the
 * compressed value exceeds REPLAY_KAFKA_MAX_TOTAL_BYTES; THROWS on an
 * unrecoverable send failure so /track errors -> SDK retry.
 */
export const produceReplayChunk = async (
  chunk: IClickhouseSessionReplayChunk,
  key: string,
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
    const value = encodeReplayLine(line);
    const compressedBytes = value.length;
    const headers: Record<string, string> = {
      'content-encoding': REPLAY_KAFKA_CODEC,
    };
    const tp = currentTraceparent();
    if (tp) {
      headers.traceparent = tp;
    }

    if (compressedBytes <= REPLAY_KAFKA_MAX_BYTES) {
      const p = await getReplayProducer();
      await p.send({
        topic: KAFKA_REPLAY_TOPIC,
        messages: [{ key, value, headers }],
      });
      return { status: 'produced', compressedBytes, parts: 1 };
    }

    const parts = splitReplayValue(value, REPLAY_KAFKA_MAX_BYTES);
    if (
      !REPLAY_KAFKA_SPLIT_ENABLED ||
      compressedBytes > REPLAY_KAFKA_MAX_TOTAL_BYTES ||
      parts.length > REPLAY_KAFKA_MAX_PARTS
    ) {
      return { status: 'oversize', compressedBytes, parts: 0 };
    }
    if (
      REPLAY_KAFKA_MAX_INFLIGHT_PART_BYTES > 0 &&
      inFlightPartBytes + compressedBytes > REPLAY_KAFKA_MAX_INFLIGHT_PART_BYTES
    ) {
      throw new Error(
        `replay produce backpressure: ${inFlightPartBytes} part bytes in-flight + ${compressedBytes} > cap ${REPLAY_KAFKA_MAX_INFLIGHT_PART_BYTES}`,
      );
    }
    inFlightPartBytes += compressedBytes;
    try {
      await sendReplayParts(parts, key, headers);
    } finally {
      inFlightPartBytes -= compressedBytes;
    }
    return { status: 'produced', compressedBytes, parts: parts.length };
  } finally {
    inFlightProduces--;
  }
};

// One awaited send PER PART, never all parts in one send. kafkajs has no
// linger/accumulator: each send() is its own Produce request, and the messages
// of one send() to one partition form one record batch. Event Hubs Standard
// rejects a request/batch over 1 MB, so N parts in one send() (one N x 950 KB
// batch) would always fail; one part per send keeps every request at a single
// <= REPLAY_KAFKA_MAX_BYTES message. Awaiting each ack before the next part
// also fixes the order on the partition (part i is only sent once part i-1 is
// stored), even with maxInFlightRequests > 1 and broker retries.
//
// The parts are NOT contiguous: other /track requests (this pod's and other
// pods') produce to the same partition between them. Serialising per partition
// would only cover this pod, so the consumer reassembles by chunk id and
// tolerates interleaving instead (apps/worker/src/jobs/replay-parts.ts). A
// failed part throws: the parts already stored stay behind as an incomplete
// set, which the consumer drops once it is clearly abandoned, and the SDK
// retry resends the whole chunk under a new chunk id.
const sendReplayParts = async (
  parts: Buffer[],
  key: string,
  baseHeaders: Record<string, string>,
): Promise<void> => {
  const p = await getReplayProducer();
  const chunkId = randomUUID();
  const started = Date.now();
  for (let i = 0; i < parts.length; i++) {
    if (i > 0 && Date.now() - started > REPLAY_KAFKA_PARTS_DEADLINE_MS) {
      throw new Error(
        `replay parts produce deadline exceeded: ${i}/${parts.length} parts sent in ${Date.now() - started}ms`,
      );
    }
    await p.send({
      topic: KAFKA_REPLAY_TOPIC,
      messages: [
        {
          key,
          value: parts[i]!,
          headers: {
            ...baseHeaders,
            [REPLAY_CHUNK_ID_HEADER]: chunkId,
            [REPLAY_PART_HEADER]: String(i),
            [REPLAY_PARTS_HEADER]: String(parts.length),
          },
        },
      ],
    });
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
    // Replay messages are ~KB to MB each (events are ~1 KB) and a split chunk's
    // parts must all fit in one partition batch: see the sizing note above.
    maxBytesPerPartition: REPLAY_KAFKA_MAX_BYTES_PER_PARTITION,
    maxBytes: REPLAY_KAFKA_FETCH_MAX_BYTES,
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
