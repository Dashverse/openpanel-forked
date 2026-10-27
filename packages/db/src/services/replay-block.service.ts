import { createLogger } from '@openpanel/logger';
import {
  appendReplayBlock,
  compressReplayBlock,
  replayBlockBlobPath,
} from '../blob/replay-blocks';
/**
 * Blob-primary replay: write path (Phase 2).
 *
 * `writeSessionReplayBlocks` takes the decompressed chunk lines of ONE Kafka
 * batch (with each line's Kafka offset), groups them by (session, window),
 * appends one zstd block per group to that session's append blob, and records a reference
 * row per block in `session_replay_blocks` — no payload in ClickHouse.
 *
 * block_index = the Kafka offset of the block's first chunk: monotonic per
 * session (a session's messages are offset-ordered on one partition) and unique
 * per block. It is NOT stable across a rebalance: the new partition owner resumes
 * from the last committed offset, which can be earlier, so the same chunks can be
 * re-appended under a different block_index and ReplacingMergeTree keeps both
 * refs. Readers must therefore de-dup by chunk ((started_at, chunk_index)), the
 * same contract the CH chunk path already serves with — never rely on FINAL.
 */
import type { IClickhouseSessionReplayChunk } from '../buffers/replay-buffer';
import { TABLE_NAMES, ch } from '../clickhouse/client';

export interface IClickhouseSessionReplayBlock {
  project_id: string;
  session_id: string;
  window_id: string;
  block_index: number;
  blob_path: string;
  byte_start: number;
  byte_end: number;
  chunk_lo: number;
  chunk_hi: number;
  first_started_at: string;
  last_started_at: string;
  events_count: number;
  size_bytes: number;
  codec: string;
  /**
   * Payload-free key of every chunk in the block, in block order:
   * [chunk_index, started_ms, ended_ms, is_full_snapshot]. Lets the reader build
   * the session's chunk index without downloading blocks (migration 26).
   */
  chunk_keys: ReplayBlockChunkKey[];
}

/** [chunk_index, started_ms, ended_ms, is_full_snapshot(0|1)] */
export type ReplayBlockChunkKey = [number, number, number, number];

const CH_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * A chunk's `started_at` / `ended_at` as Unix ms - the value ClickHouse stores
 * for the same JSONEachRow line in a DateTime64(3) column (best_effort input,
 * UTC server): ISO / 'YYYY-MM-DD hh:mm:ss[.fff]' with no zone = UTC, sub-ms
 * digits truncated, numeric = Unix seconds. NaN when unparseable.
 */
// A numeric timestamp at or above this is epoch MILLISECONDS (JS Date.now()),
// below it epoch seconds (ClickHouse's JSON reading). 1e11 s is the year 5138
// and 1e11 ms is 1973, so real values on either side can't be confused.
const EPOCH_MS_THRESHOLD = 1e11;
const epochToMs = (n: number) =>
  n >= EPOCH_MS_THRESHOLD ? Math.floor(n) : Math.floor(n * 1000);

export function parseReplayTimestampMs(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? epochToMs(value) : Number.NaN;
  }
  if (typeof value !== 'string') return Number.NaN;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) {
    return epochToMs(Number(v));
  }
  const m = CH_DATETIME_RE.exec(v);
  if (m) {
    const ms = Number(`${m[7] ?? ''}000`.slice(0, 3));
    let t = Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
      ms,
    );
    const tz = m[8];
    if (tz && tz.toUpperCase() !== 'Z') {
      const sign = tz[0] === '-' ? -1 : 1;
      const digits = tz.slice(1).replace(':', '');
      const offMin =
        Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0');
      t -= sign * offMin * 60_000;
    }
    return t;
  }
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) ? Math.floor(parsed) : Number.NaN;
}

/** Same truthiness ClickHouse's Bool column applies to the JSON value. */
export function replayFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/** The chunk-key tuple of one parsed chunk (see `chunk_keys`). */
export function replayChunkKeyOf(
  chunk: Pick<
    IClickhouseSessionReplayChunk,
    'chunk_index' | 'started_at' | 'ended_at' | 'is_full_snapshot'
  >,
): ReplayBlockChunkKey | null {
  const startedMs = parseReplayTimestampMs(chunk.started_at);
  if (!Number.isFinite(startedMs)) return null;
  const endedRaw = parseReplayTimestampMs(chunk.ended_at);
  return [
    Number(chunk.chunk_index) || 0,
    startedMs,
    Number.isFinite(endedRaw) ? endedRaw : startedMs,
    replayFlag(chunk.is_full_snapshot) ? 1 : 0,
  ];
}

// Sessions in one batch are independent blobs, so append a few concurrently
// (partitions are consumed one at a time per pod, so this is the only fan-out).
const BLOCK_WRITE_CONCURRENCY = (() => {
  const n = Number.parseInt(process.env.REPLAY_BLOCKS_CONCURRENCY ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
})();

// How long ClickHouse may hold ref inserts to coalesce them into one part.
// The default adaptive async-insert timeout flushes within ~200 ms, which in
// prod (2026-10-21) made ~31,500 new parts/hour for a few KB of refs, and with
// them ~62,000 merges, ~63,000 replica downloads and ~158,000 part removals per
// hour across the 3 replicas (Keeper and merge CPU, not query CPU). A fixed
// window turns that into roughly one part per node per window. The consumer
// waits for the flush (wait_for_async_insert) before resolving offsets, so the
// window is added latency per Kafka batch, well inside the batch deadline.
// 0 = ClickHouse's default (adaptive) behaviour. Other values are clamped to
// [MIN, MAX]: at or above REPLAY_BLOCKS_TIMEOUT_MS (20 s) every ref insert
// would abort, and a typo like "2s" must not become a 2 ms window.
export const REFS_ASYNC_INSERT_TIMEOUT_DEFAULT_MS = 2000;
export const REFS_ASYNC_INSERT_TIMEOUT_MIN_MS = 200;
export const REFS_ASYNC_INSERT_TIMEOUT_MAX_MS = 10_000;

/** Parse REPLAY_BLOCKS_ASYNC_INSERT_TIMEOUT_MS (exported for tests). */
export function parseRefsAsyncInsertTimeoutMs(
  raw: string | undefined,
  warn: (msg: string, meta: Record<string, unknown>) => void = () => {},
): number {
  const value = (raw ?? '').trim();
  if (value === '') return REFS_ASYNC_INSERT_TIMEOUT_DEFAULT_MS;
  if (!/^\d+$/.test(value)) {
    warn(
      'REPLAY_BLOCKS_ASYNC_INSERT_TIMEOUT_MS is not a whole number of ms; using the default',
      { value: raw, usedMs: REFS_ASYNC_INSERT_TIMEOUT_DEFAULT_MS },
    );
    return REFS_ASYNC_INSERT_TIMEOUT_DEFAULT_MS;
  }
  const n = Number.parseInt(value, 10);
  if (n === 0) return 0;
  const clamped = Math.min(
    REFS_ASYNC_INSERT_TIMEOUT_MAX_MS,
    Math.max(REFS_ASYNC_INSERT_TIMEOUT_MIN_MS, n),
  );
  if (clamped !== n) {
    warn('REPLAY_BLOCKS_ASYNC_INSERT_TIMEOUT_MS out of range; clamped', {
      value: n,
      usedMs: clamped,
      minMs: REFS_ASYNC_INSERT_TIMEOUT_MIN_MS,
      maxMs: REFS_ASYNC_INSERT_TIMEOUT_MAX_MS,
    });
  }
  return clamped;
}

const REFS_ASYNC_INSERT_TIMEOUT_MS = parseRefsAsyncInsertTimeoutMs(
  process.env.REPLAY_BLOCKS_ASYNC_INSERT_TIMEOUT_MS,
  (msg, meta) => createLogger({ name: 'replay-blocks' }).warn(msg, meta),
);

// ClickHouse only coalesces async inserts whose settings are identical. The
// client wrapper stamps a per-request log_comment (trace_id, span_id), which
// made every ref insert its own async-insert bucket and so its own part,
// whatever the busy timeout. A fixed log_comment here (caller settings win over
// the wrapper's) keeps the settings identical across inserts; per-insert trace
// attribution means little once inserts are flushed together anyway.
const REFS_LOG_COMMENT = JSON.stringify({
  service: process.env.OTEL_SERVICE_NAME ?? 'openpanel-unknown',
  endpoint: 'replay.insertReplayBlocks',
});

/** ClickHouse settings for a refs insert (exported for tests). */
export function replayBlockRefsInsertSettings(timeoutMs: number) {
  return {
    async_insert: 1,
    wait_for_async_insert: 1,
    input_format_skip_unknown_fields: 1,
    log_comment: REFS_LOG_COMMENT,
    ...(timeoutMs > 0
      ? {
          async_insert_use_adaptive_busy_timeout: 0,
          async_insert_busy_timeout_max_ms: timeoutMs,
        }
      : {}),
  } as const;
}

export async function insertReplayBlocks(
  rows: IClickhouseSessionReplayBlock[],
  opts: { abortSignal?: AbortSignal } = {},
): Promise<void> {
  if (rows.length === 0) return;
  await ch.insert({
    table: TABLE_NAMES.session_replay_blocks,
    values: rows,
    format: 'JSONEachRow',
    abort_signal: opts.abortSignal,
    // Same as the chunk inserts: one tiny ref insert per Kafka batch would make
    // a part per batch, so let ClickHouse coalesce them (async_insert) — and wait
    // for the write, because the consumer resolves Kafka offsets after this ack.
    // skip_unknown_fields: a writer deployed before migration 26 (chunk_keys)
    // must not fail the insert on the new field. Flush window: see
    // REFS_ASYNC_INSERT_TIMEOUT_MS.
    clickhouse_settings: replayBlockRefsInsertSettings(
      REFS_ASYNC_INSERT_TIMEOUT_MS,
    ),
  });
}

export interface ReplayLineWithOffset {
  /** `JSON.stringify(IClickhouseSessionReplayChunk)` — the exact CH row line. */
  line: string;
  /** Kafka offset of this message. */
  offset: number;
}

export interface WriteBlocksResult {
  blocks: number;
  bytes: number;
  /** Lines skipped: not JSON, or no parseable started_at (unplayable). */
  skipped?: number;
}

/** Run `fn` over `items` with at most `limit` in flight; rejects on first error. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Append one zstd block per session for a batch's chunk lines, then record the
 * refs. Returns counts for metrics. Throws on any blob/CH failure (including the
 * caller's abortSignal firing) — the caller decides whether that blocks the batch.
 */
export async function writeSessionReplayBlocks(
  items: ReplayLineWithOffset[],
  opts: { abortSignal?: AbortSignal } = {},
): Promise<WriteBlocksResult> {
  if (items.length === 0) return { blocks: 0, bytes: 0, skipped: 0 };

  // Group by session, parsing each line once. (Parsing the whole line includes
  // the fat `payload`; acceptable on the worker — see plan note on carrying
  // metadata in Kafka headers as a future optimization.)
  interface Group {
    projectId: string;
    sessionId: string;
    windowId: string;
    firstOffset: number;
    chunks: {
      chunk: IClickhouseSessionReplayChunk;
      line: string;
      startedMs: number;
    }[];
  }
  const groups = new Map<string, Group>();
  let skipped = 0;
  for (const { line, offset } of items) {
    let chunk: IClickhouseSessionReplayChunk;
    try {
      chunk = JSON.parse(line) as IClickhouseSessionReplayChunk;
    } catch {
      skipped++;
      continue; // malformed; CH path logs/counts it separately
    }
    // No usable start time = no place on the timeline (and it used to throw in
    // the sort below, failing the batch on every redelivery). /track rejects
    // these now; this catches lines already in Kafka.
    const startedMs = parseReplayTimestampMs(chunk.started_at);
    if (!Number.isFinite(startedMs)) {
      skipped++;
      continue;
    }
    // One block per (project, session, window): a session_id is shared across
    // tabs, and each block's ref records a single window_id.
    const key = `${chunk.project_id}:${chunk.session_id}:${chunk.window_id ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        projectId: chunk.project_id,
        sessionId: chunk.session_id,
        windowId: chunk.window_id ?? '',
        firstOffset: offset,
        chunks: [],
      };
      groups.set(key, g);
    }
    g.firstOffset = Math.min(g.firstOffset, offset);
    g.chunks.push({ chunk, line, startedMs });
  }

  const refs = await mapWithConcurrency(
    Array.from(groups.values()),
    BLOCK_WRITE_CONCURRENCY,
    async (g): Promise<IClickhouseSessionReplayBlock> => {
      // Order the block's content by (started_at, chunk_index) — the same
      // contract the reader re-derives its synthetic seq from.
      g.chunks.sort(
        (a, b) =>
          a.startedMs - b.startedMs ||
          (Number(a.chunk.chunk_index) || 0) -
            (Number(b.chunk.chunk_index) || 0),
      );
      const first = g.chunks[0]!;
      const last = g.chunks[g.chunks.length - 1]!;
      const firstMs = first.startedMs;
      // The chunk's own string as written to CH chunks (same parse there);
      // a non-string (numeric seconds from an old line) as ISO.
      const tsOf = (c: (typeof g.chunks)[number]) =>
        typeof c.chunk.started_at === 'string'
          ? c.chunk.started_at
          : new Date(c.startedMs).toISOString();
      const blobPath = replayBlockBlobPath(
        g.projectId,
        g.sessionId,
        new Date(firstMs),
      );
      const block = compressReplayBlock(g.chunks.map((c) => c.line));
      const { byteStart, byteEnd } = await appendReplayBlock(blobPath, block, {
        abortSignal: opts.abortSignal,
      });

      let chunkLo = Number.POSITIVE_INFINITY;
      let chunkHi = 0;
      let events = 0;
      // All or nothing: the reader trusts a non-empty chunk_keys as the
      // block's full index, so one unkeyable chunk means write [] and let the
      // reader decode the block instead.
      let chunkKeys: ReplayBlockChunkKey[] = [];
      let allKeyed = true;
      for (const { chunk } of g.chunks) {
        chunkLo = Math.min(chunkLo, chunk.chunk_index);
        chunkHi = Math.max(chunkHi, chunk.chunk_index);
        events += chunk.events_count ?? 0;
        const key = replayChunkKeyOf(chunk);
        if (key) chunkKeys.push(key);
        else allKeyed = false;
      }
      if (!allKeyed) chunkKeys = [];

      return {
        project_id: g.projectId,
        session_id: g.sessionId,
        window_id: g.windowId,
        block_index: g.firstOffset,
        blob_path: blobPath,
        byte_start: byteStart,
        byte_end: byteEnd,
        chunk_lo: Number.isFinite(chunkLo) ? chunkLo : 0,
        chunk_hi: chunkHi,
        first_started_at: tsOf(first),
        last_started_at: tsOf(last),
        events_count: events,
        size_bytes: block.length,
        codec: 'zstd',
        chunk_keys: chunkKeys,
      };
    },
  );

  await insertReplayBlocks(refs, { abortSignal: opts.abortSignal });
  return {
    blocks: refs.length,
    bytes: refs.reduce((sum, r) => sum + r.size_bytes, 0),
    skipped,
  };
}
