import {
  appendReplayBlock,
  compressReplayBlock,
  replayBlockBlobPath,
} from '../blob/replay-blocks';
/**
 * Blob-primary replay: write path (Phase 2).
 *
 * `writeSessionReplayBlocks` takes the decompressed chunk lines of ONE Kafka
 * batch (with each line's Kafka offset), groups them by session, appends one
 * zstd block per session to that session's append blob, and records a reference
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
}

// Sessions in one batch are independent blobs, so append a few concurrently
// (partitions are consumed one at a time per pod, so this is the only fan-out).
const BLOCK_WRITE_CONCURRENCY = (() => {
  const n = Number.parseInt(process.env.REPLAY_BLOCKS_CONCURRENCY ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
})();

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
    clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
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
  if (items.length === 0) return { blocks: 0, bytes: 0 };

  // Group by session, parsing each line once. (Parsing the whole line includes
  // the fat `payload`; acceptable on the worker — see plan note on carrying
  // metadata in Kafka headers as a future optimization.)
  interface Group {
    projectId: string;
    sessionId: string;
    windowId: string;
    firstOffset: number;
    chunks: { chunk: IClickhouseSessionReplayChunk; line: string }[];
  }
  const groups = new Map<string, Group>();
  for (const { line, offset } of items) {
    let chunk: IClickhouseSessionReplayChunk;
    try {
      chunk = JSON.parse(line) as IClickhouseSessionReplayChunk;
    } catch {
      continue; // malformed; CH path logs/counts it separately
    }
    const key = `${chunk.project_id}:${chunk.session_id}`;
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
    g.chunks.push({ chunk, line });
  }

  const refs = await mapWithConcurrency(
    Array.from(groups.values()),
    BLOCK_WRITE_CONCURRENCY,
    async (g): Promise<IClickhouseSessionReplayBlock> => {
      // Order the block's content by (started_at, chunk_index) — the same
      // contract the reader re-derives its synthetic seq from.
      g.chunks.sort(
        (a, b) =>
          a.chunk.started_at.localeCompare(b.chunk.started_at) ||
          a.chunk.chunk_index - b.chunk.chunk_index,
      );
      const first = g.chunks[0]!.chunk;
      const last = g.chunks[g.chunks.length - 1]!.chunk;
      const blobPath = replayBlockBlobPath(
        g.projectId,
        g.sessionId,
        first.started_at,
      );
      const block = compressReplayBlock(g.chunks.map((c) => c.line));
      const { byteStart, byteEnd } = await appendReplayBlock(blobPath, block, {
        abortSignal: opts.abortSignal,
      });

      let chunkLo = Number.POSITIVE_INFINITY;
      let chunkHi = 0;
      let events = 0;
      for (const { chunk } of g.chunks) {
        chunkLo = Math.min(chunkLo, chunk.chunk_index);
        chunkHi = Math.max(chunkHi, chunk.chunk_index);
        events += chunk.events_count ?? 0;
      }

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
        first_started_at: first.started_at,
        last_started_at: last.started_at,
        events_count: events,
        size_bytes: block.length,
        codec: 'zstd',
      };
    },
  );

  await insertReplayBlocks(refs, { abortSignal: opts.abortSignal });
  return {
    blocks: refs.length,
    bytes: refs.reduce((sum, r) => sum + r.size_bytes, 0),
  };
}
