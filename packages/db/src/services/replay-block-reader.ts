/**
 * Blob-primary replay: READ path (Phase 2).
 *
 * Serves a session's replay from the zstd blocks in Azure Blob, addressed by
 * the byte-range refs in `session_replay_blocks` (see replay-block.service.ts
 * for the writer). Everything here reproduces, in process, the exact chunk
 * contract the SQL readers in session.service.ts apply to
 * `session_replay_chunks`, so the player sees identical `ReplayChunkItem`
 * sequences whichever store serves:
 *
 *   - a chunk is keyed by (chunk_index, started_at) within the read scope (one
 *     window, or the whole session); duplicates - exact SDK retries, a Kafka
 *     redelivery re-appending the same chunks under a new block_index - collapse
 *     to one, with is_full_snapshot = max over the duplicates;
 *   - keys are ordered by (started_at, chunk_index) and numbered with a
 *     synthetic contiguous `seq` (0-based) - the index the player drains.
 *
 * Pure helpers (index, scope, windows, segments, meta) take plain data so they
 * can be unit-tested against the SQL contract; the I/O helpers fetch refs and
 * range-GET only the blocks a page needs (adjacent ranges in the same blob are
 * coalesced into one GET, one zstd frame is decoded per ref).
 */
import sqlstring from 'sqlstring';
import {
  decompressReplayBlock,
  isReplayBlockStoreConfigured,
  readReplayBlockRange,
} from '../blob/replay-blocks';
import { TABLE_NAMES, chQuery } from '../clickhouse/client';
import {
  type ReplayBlockChunkKey,
  parseReplayTimestampMs,
  replayFlag,
} from './replay-block.service';

// --- Config -----------------------------------------------------------------

const positiveIntEnv = (name: string, fallback: number): number => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** CSV of project ids, or `*`. Empty = off (legacy serving, unchanged). */
export function parseProjectAllowList(raw: string | undefined): {
  all: boolean;
  ids: Set<string>;
} {
  const v = (raw ?? '').trim();
  if (v === '*') return { all: true, ids: new Set() };
  return {
    all: false,
    ids: new Set(
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  };
}

const SERVE_BLOCKS = parseProjectAllowList(
  process.env.REPLAY_SERVE_BLOCKS_PROJECT_IDS,
);

const DEFAULT_COMPLETE_SINCE = '2026-10-10T00:00:00Z';
/**
 * Sessions whose FIRST ref was created at/after this instant have every chunk
 * in blocks (the dual-write rollout finished before it) → served from blocks
 * alone. Older sessions (partial blocks) stay on the legacy path - one source
 * per session, never mixed.
 */
export const REPLAY_BLOCKS_COMPLETE_SINCE_MS = (() => {
  const raw =
    process.env.REPLAY_BLOCKS_COMPLETE_SINCE || DEFAULT_COMPLETE_SINCE;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : Date.parse(DEFAULT_COMPLETE_SINCE);
})();

/** Serve this project's replays from blocks (allow-listed AND blob configured). */
export function isReplayBlocksServingEnabled(projectId: string): boolean {
  if (!isReplayBlockStoreConfigured()) return false;
  return SERVE_BLOCKS.all || SERVE_BLOCKS.ids.has(projectId);
}

const READ_CONCURRENCY = positiveIntEnv('REPLAY_BLOCKS_READ_CONCURRENCY', 4);
// One coalesced GET never exceeds this (a single bigger block is fetched alone).
const MAX_RANGE_BYTES = positiveIntEnv(
  'REPLAY_BLOCKS_MAX_RANGE_BYTES',
  8 * 1024 * 1024,
);
// Merge two refs' ranges into one GET when the bytes between them (another
// window's blocks, usually) are at most this many - fewer round trips for a
// little extra transfer.
const COALESCE_GAP_BYTES = (() => {
  const n = Number.parseInt(
    process.env.REPLAY_BLOCKS_COALESCE_GAP_BYTES ?? '',
    10,
  );
  return Number.isFinite(n) && n >= 0 ? n : 64 * 1024;
})();

// --- Types ------------------------------------------------------------------

export interface ReplayBlockRef {
  windowId: string;
  blockIndex: number;
  blobPath: string;
  byteStart: number;
  byteEnd: number; // exclusive
  createdAtMs: number;
  /** first_started_at as Unix ms: the block's earliest chunk. */
  firstStartedMs: number;
  /** last_started_at as Unix ms: the START of the block's latest chunk. */
  lastStartedMs: number;
  eventsCount: number;
  sizeBytes: number;
  /** From the `chunk_keys` column; empty for refs written before it existed. */
  chunkKeys: ReplayBlockChunkKey[];
}

/** One distinct chunk of the session: (window_id, chunk_index, started_ms). */
export interface ReplayIndexRow {
  windowId: string;
  chunkIndex: number;
  startedMs: number;
  endedMs: number;
  isFullSnapshot: boolean;
  /** Blocks holding this chunk (several when blocks were re-appended). */
  refs: ReplayBlockRef[];
}

/** A chunk key in a read scope, numbered like `replayChunkKeysSql`. */
export interface ReplayScopedKey {
  seq: number;
  chunkIndex: number;
  startedMs: number;
  isFullSnapshot: boolean;
  rows: ReplayIndexRow[];
}

export interface ReplayKeyInput {
  windowId: string;
  chunkIndex: number;
  startedMs: number;
  endedMs: number;
  isFullSnapshot: boolean;
}

// --- Pure index helpers -----------------------------------------------------

/**
 * Build the session's chunk index from its blocks' keys, de-duplicated by
 * (window_id, chunk_index, started_ms): is_full_snapshot = OR, ended = max,
 * every holding ref kept.
 */
export function buildReplayIndex(
  blockKeys: { ref: ReplayBlockRef; key: ReplayKeyInput }[],
): ReplayIndexRow[] {
  const byKey = new Map<string, ReplayIndexRow>();
  const upsert = (k: ReplayKeyInput): ReplayIndexRow => {
    const id = `${k.windowId}\u0000${k.chunkIndex}\u0000${k.startedMs}`;
    let row = byKey.get(id);
    if (!row) {
      row = {
        windowId: k.windowId,
        chunkIndex: k.chunkIndex,
        startedMs: k.startedMs,
        endedMs: k.endedMs,
        isFullSnapshot: k.isFullSnapshot,
        refs: [],
      };
      byKey.set(id, row);
    } else {
      if (k.endedMs > row.endedMs) row.endedMs = k.endedMs;
      if (k.isFullSnapshot) row.isFullSnapshot = true;
    }
    return row;
  };
  for (const { ref, key } of blockKeys) {
    const row = upsert(key);
    if (!row.refs.includes(ref)) row.refs.push(ref);
  }
  return Array.from(byKey.values()).sort(
    (a, b) =>
      a.startedMs - b.startedMs ||
      a.chunkIndex - b.chunkIndex ||
      (a.windowId < b.windowId ? -1 : a.windowId > b.windowId ? 1 : 0),
  );
}

/**
 * The scope's ordered chunk keys - `replayChunkKeysSql` in process: GROUP BY
 * (chunk_index, started_at) over the scope (one window, or the whole session
 * when `windowId` is undefined), max(is_full_snapshot), ORDER BY (started_at,
 * chunk_index), seq = row_number - 1.
 */
export function scopeReplayKeys(
  index: ReplayIndexRow[],
  windowId?: string,
): ReplayScopedKey[] {
  const groups = new Map<string, ReplayScopedKey>();
  for (const row of index) {
    if (windowId !== undefined && row.windowId !== windowId) continue;
    const id = `${row.chunkIndex}\u0000${row.startedMs}`;
    const g = groups.get(id);
    if (g) {
      g.rows.push(row);
      if (row.isFullSnapshot) g.isFullSnapshot = true;
    } else {
      groups.set(id, {
        seq: 0,
        chunkIndex: row.chunkIndex,
        startedMs: row.startedMs,
        isFullSnapshot: row.isFullSnapshot,
        rows: [row],
      });
    }
  }
  const keys = Array.from(groups.values()).sort(
    (a, b) => a.startedMs - b.startedMs || a.chunkIndex - b.chunkIndex,
  );
  keys.forEach((k, i) => {
    k.seq = i;
  });
  return keys;
}

/** Seek anchor exactly as the readers compute it: last full snapshot ≤ target. */
export function replayAnchorSeq(
  keys: ReplayScopedKey[],
  targetMs: number,
): number {
  return keys.reduce(
    (a, k) =>
      k.isFullSnapshot && k.startedMs <= targetMs ? Math.max(a, k.seq) : a,
    0,
  );
}

/**
 * Idle-collapsed active time for a window's rows ordered by (started,
 * chunk_index) - `replayActiveMsExpr` over `replayWindowRowsSql` in process.
 */
export function replayActiveMs(
  rows: { startedMs: number; endedMs: number }[],
  idleGapMs: number,
): number {
  if (rows.length === 0) return 0;
  let minS = Number.POSITIVE_INFINITY;
  let maxE = Number.NEGATIVE_INFINITY;
  let runningMaxE = 0; // CH: max over an empty frame = 0 → "prev_e_ms > 0" guard
  let gaps = 0;
  rows.forEach((r, i) => {
    if (i > 0 && runningMaxE > 0 && r.startedMs - runningMaxE >= idleGapMs) {
      gaps += r.startedMs - runningMaxE;
    }
    runningMaxE = i === 0 ? r.endedMs : Math.max(runningMaxE, r.endedMs);
    minS = Math.min(minS, r.startedMs);
    maxE = Math.max(maxE, r.endedMs);
  });
  return Math.max(0, maxE - minS - gaps);
}

export interface ReplayWindowSummary {
  windowId: string;
  chunkCount: number;
  fullSnapshotCount: number;
  startedAtMs: number;
  endedAtMs: number;
  activeMs: number;
}

/** `getSessionWindows` in process (one row per window, ordered by start). */
export function computeReplayWindows(
  index: ReplayIndexRow[],
  idleGapMs: number,
): ReplayWindowSummary[] {
  const byWindow = new Map<string, ReplayIndexRow[]>();
  for (const row of index) {
    const list = byWindow.get(row.windowId);
    if (list) list.push(row);
    else byWindow.set(row.windowId, [row]);
  }
  const out: ReplayWindowSummary[] = [];
  for (const [windowId, rows] of byWindow) {
    rows.sort(
      (a, b) => a.startedMs - b.startedMs || a.chunkIndex - b.chunkIndex,
    );
    let startedAtMs = Number.POSITIVE_INFINITY;
    let endedAtMs = Number.NEGATIVE_INFINITY;
    let fullSnapshotCount = 0;
    for (const r of rows) {
      startedAtMs = Math.min(startedAtMs, r.startedMs);
      endedAtMs = Math.max(endedAtMs, r.endedMs);
      if (r.isFullSnapshot) fullSnapshotCount++;
    }
    out.push({
      windowId,
      chunkCount: rows.length,
      fullSnapshotCount,
      startedAtMs,
      endedAtMs,
      activeMs: replayActiveMs(rows, idleGapMs),
    });
  }
  return out.sort(
    (a, b) =>
      a.startedAtMs - b.startedAtMs ||
      (a.windowId < b.windowId ? -1 : a.windowId > b.windowId ? 1 : 0),
  );
}

/** `getSessionWindowSegments` in process. */
export function computeReplaySegments(
  index: ReplayIndexRow[],
  idleGapMs: number,
  windowId?: string,
): { startMs: number; endMs: number }[] {
  const rows = index
    .filter((r) => windowId === undefined || r.windowId === windowId)
    .sort((a, b) => a.startedMs - b.startedMs);
  const segments: { startMs: number; endMs: number }[] = [];
  for (const row of rows) {
    const startMs = row.startedMs;
    const endMs = Math.max(startMs, row.endedMs);
    const last = segments[segments.length - 1];
    if (last && startMs - last.endMs < idleGapMs) {
      if (endMs > last.endMs) last.endMs = endMs;
    } else {
      segments.push({ startMs, endMs });
    }
  }
  return segments;
}

/** `getSessionReplayMeta` aggregates in process (null when no chunks). */
export function computeReplayMeta(
  index: ReplayIndexRow[],
): { startedAtMs: number; endedAtMs: number; chunkCount: number } | null {
  if (index.length === 0) return null;
  let s = Number.POSITIVE_INFINITY;
  let e = Number.NEGATIVE_INFINITY;
  for (const r of index) {
    s = Math.min(s, r.startedMs);
    e = Math.max(e, r.endedMs);
  }
  return { startedAtMs: s, endedAtMs: e, chunkCount: index.length };
}

// --- Line parsing -----------------------------------------------------------

export interface ReplayLineHead {
  window_id: string;
  chunk_index: number;
  started_at: unknown;
  ended_at: unknown;
  is_full_snapshot: unknown;
}

/**
 * Parse a block line's metadata WITHOUT materialising the (fat) payload. The
 * writer's lines are `JSON.stringify(chunk)` with `payload` last; inside a JSON
 * string every `"` is escaped, so the first `,"payload":` is the top-level key.
 * Falls back to a full parse when that shortcut doesn't yield the key fields.
 */
export function parseReplayLineHead(line: string): ReplayLineHead | null {
  const idx = line.indexOf(',"payload":');
  if (idx > 0) {
    try {
      const head = JSON.parse(
        `${line.slice(0, idx)}}`,
      ) as Partial<ReplayLineHead>;
      if (head.chunk_index !== undefined && head.started_at !== undefined) {
        return { ...head, window_id: head.window_id ?? '' } as ReplayLineHead;
      }
    } catch {
      // fall through
    }
  }
  try {
    const full = JSON.parse(line) as Partial<ReplayLineHead>;
    return { ...full, window_id: full.window_id ?? '' } as ReplayLineHead;
  } catch {
    return null;
  }
}

export function keyFromLineHead(head: ReplayLineHead): ReplayKeyInput | null {
  const startedMs = parseReplayTimestampMs(head.started_at);
  if (!Number.isFinite(startedMs)) return null;
  const endedRaw = parseReplayTimestampMs(head.ended_at);
  return {
    windowId: head.window_id ?? '',
    chunkIndex: Number(head.chunk_index) || 0,
    startedMs,
    endedMs: Number.isFinite(endedRaw) ? endedRaw : startedMs,
    isFullSnapshot: replayFlag(head.is_full_snapshot),
  };
}

// --- Range planning ---------------------------------------------------------

export interface ReplayRangeGet {
  blobPath: string;
  start: number;
  end: number; // exclusive
  refs: ReplayBlockRef[];
}

/**
 * Plan the GETs for a set of refs: dedupe identical ranges, group by blob, and
 * coalesce refs whose ranges are adjacent (or separated by ≤ gapBytes) while
 * the merged range stays ≤ maxBytes.
 */
export function planReplayRangeGets(
  refs: ReplayBlockRef[],
  gapBytes = COALESCE_GAP_BYTES,
  maxBytes = MAX_RANGE_BYTES,
): ReplayRangeGet[] {
  const unique = new Map<string, ReplayBlockRef>();
  for (const r of refs) {
    unique.set(`${r.blobPath}\u0000${r.byteStart}\u0000${r.byteEnd}`, r);
  }
  const sorted = Array.from(unique.values()).sort((a, b) =>
    a.blobPath === b.blobPath
      ? a.byteStart - b.byteStart
      : a.blobPath < b.blobPath
        ? -1
        : 1,
  );
  const gets: ReplayRangeGet[] = [];
  for (const ref of sorted) {
    const cur = gets[gets.length - 1];
    if (
      cur &&
      cur.blobPath === ref.blobPath &&
      ref.byteStart >= cur.start &&
      ref.byteStart - cur.end <= gapBytes &&
      Math.max(cur.end, ref.byteEnd) - cur.start <= maxBytes
    ) {
      cur.end = Math.max(cur.end, ref.byteEnd);
      cur.refs.push(ref);
    } else {
      gets.push({
        blobPath: ref.blobPath,
        start: ref.byteStart,
        end: ref.byteEnd,
        refs: [ref],
      });
    }
  }
  return gets;
}

/**
 * Pick the fewest blocks covering the wanted keys: per key, reuse an already
 * chosen holder, else the holder that covers the most wanted keys (ties →
 * lowest block_index).
 */
export function chooseReplayRefs(keys: ReplayScopedKey[]): ReplayBlockRef[] {
  const cover = new Map<ReplayBlockRef, number>();
  const holders = keys.map((k) => {
    const set = new Set<ReplayBlockRef>();
    for (const row of k.rows) for (const ref of row.refs) set.add(ref);
    for (const ref of set) cover.set(ref, (cover.get(ref) ?? 0) + 1);
    return set;
  });
  const chosen = new Set<ReplayBlockRef>();
  for (const set of holders) {
    if (set.size === 0) continue;
    let hit = false;
    for (const ref of set) {
      if (chosen.has(ref)) {
        hit = true;
        break;
      }
    }
    if (hit) continue;
    let best: ReplayBlockRef | undefined;
    for (const ref of set) {
      if (
        !best ||
        cover.get(ref)! > cover.get(best)! ||
        (cover.get(ref) === cover.get(best) && ref.blockIndex < best.blockIndex)
      ) {
        best = ref;
      }
    }
    chosen.add(best!);
  }
  return Array.from(chosen);
}

// --- I/O --------------------------------------------------------------------

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]!);
      }
    }),
  );
}

type RangeReader = (
  path: string,
  start: number,
  count: number,
  opts?: { abortSignal?: AbortSignal },
) => Promise<Buffer>;

/** Test seam: the range reader (defaults to the Azure range-GET). */
let rangeReader: RangeReader = readReplayBlockRange;
export function __setReplayRangeReaderForTests(fn: RangeReader | null): void {
  rangeReader = fn ?? readReplayBlockRange;
}

/**
 * True for a cancellation: the caller's signal fired (client went away), or
 * the error is an abort. A cancelled read must just stop: it is never a
 * reason to fall back to another store.
 */
export function isReplayAbortError(
  error: unknown,
  signal?: AbortSignal | null,
): boolean {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; code?: unknown };
  return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    const err = new Error('replay read aborted');
    err.name = 'AbortError';
    throw err;
  }
}

/**
 * Range-GET the refs' raw (still zstd-compressed) bytes, coalescing adjacent
 * ranges, at most READ_CONCURRENCY GETs in flight. `onRef` gets each ref's
 * exact byte slice as soon as its GET lands (so in byte order per GET, not in
 * the caller's order). The signal is passed to every Azure call: a client
 * cancel aborts the in-flight GETs and rejects with an AbortError.
 */
export async function readReplayRefsRaw(
  refs: ReplayBlockRef[],
  onRef: (ref: ReplayBlockRef, bytes: Buffer) => void | Promise<void>,
  opts: { signal?: AbortSignal | null } = {},
): Promise<void> {
  const signal = opts.signal ?? undefined;
  const gets = planReplayRangeGets(refs);
  await mapLimit(gets, READ_CONCURRENCY, async (get) => {
    throwIfAborted(signal);
    const buf = await rangeReader(
      get.blobPath,
      get.start,
      get.end - get.start,
      {
        abortSignal: signal,
      },
    );
    throwIfAborted(signal);
    if (buf.length < get.end - get.start) {
      throw new Error(
        `short read on ${get.blobPath} [${get.start}, ${get.end}): got ${buf.length} bytes`,
      );
    }
    for (const ref of get.refs) {
      await onRef(
        ref,
        buf.subarray(ref.byteStart - get.start, ref.byteEnd - get.start),
      );
    }
  });
}

/**
 * Range-GET the given refs (coalesced) and hand each ref's decoded NDJSON
 * lines to `onBlock`. At most READ_CONCURRENCY GETs (each ≤ MAX_RANGE_BYTES)
 * are in flight; a GET's buffer is dropped once its blocks are processed.
 */
export async function forEachReplayBlock(
  refs: ReplayBlockRef[],
  onBlock: (ref: ReplayBlockRef, lines: string[]) => void,
  opts: { signal?: AbortSignal | null } = {},
): Promise<void> {
  await readReplayRefsRaw(
    refs,
    (ref, bytes) => onBlock(ref, decompressReplayBlock(bytes)),
    opts,
  );
}

// Keys decoded from blocks whose ref has no chunk_keys (written before
// migration 26). Blocks are immutable, so entries never go stale.
const DECODED_KEYS_MAX = positiveIntEnv(
  'REPLAY_BLOCKS_DECODED_KEYS_CACHE',
  20_000,
);
const decodedKeys = new Map<string, ReplayKeyInput[]>();
const refId = (r: ReplayBlockRef) =>
  `${r.blobPath}\u0000${r.byteStart}\u0000${r.byteEnd}`;

/**
 * Every chunk key held by each ref: from `chunk_keys` when present, else by
 * decoding the block (cached per block).
 */
export async function resolveReplayRefKeys(
  refs: ReplayBlockRef[],
  opts: { signal?: AbortSignal | null } = {},
): Promise<{ ref: ReplayBlockRef; key: ReplayKeyInput }[]> {
  const out: { ref: ReplayBlockRef; key: ReplayKeyInput }[] = [];
  const toDecode: ReplayBlockRef[] = [];
  for (const ref of refs) {
    if (ref.chunkKeys.length > 0) {
      for (const [chunkIndex, startedMs, endedMs, full] of ref.chunkKeys) {
        out.push({
          ref,
          key: {
            windowId: ref.windowId,
            chunkIndex,
            startedMs,
            endedMs,
            isFullSnapshot: full === 1,
          },
        });
      }
      continue;
    }
    const cached = decodedKeys.get(refId(ref));
    if (cached) {
      for (const key of cached) out.push({ ref, key });
    } else {
      toDecode.push(ref);
    }
  }
  if (toDecode.length > 0) {
    await forEachReplayBlock(
      toDecode,
      (ref, lines) => {
        const keys: ReplayKeyInput[] = [];
        for (const line of lines) {
          const head = parseReplayLineHead(line);
          const key = head ? keyFromLineHead(head) : null;
          if (key) keys.push(key);
        }
        if (decodedKeys.size >= DECODED_KEYS_MAX) {
          const oldest = decodedKeys.keys().next().value;
          if (oldest !== undefined) decodedKeys.delete(oldest);
        }
        decodedKeys.set(refId(ref), keys);
        for (const key of keys) out.push({ ref, key });
      },
      opts,
    );
  }
  return out;
}

export interface ReplayBlockChunk {
  seq: number;
  startedMs: number;
  endedMs: number;
  payload: string;
}

/**
 * Load the payloads of `keys` from blocks. Only the blocks needed are fetched
 * (see chooseReplayRefs); each key is filled from the first matching line in
 * scope. Keys not found are simply absent from the result.
 */
export async function loadReplayChunksFromBlocks(
  keys: ReplayScopedKey[],
  windowId?: string,
  opts: { signal?: AbortSignal | null } = {},
): Promise<Map<number, ReplayBlockChunk>> {
  const wanted = new Map<string, number>();
  for (const k of keys)
    wanted.set(`${k.chunkIndex}\u0000${k.startedMs}`, k.seq);
  const found = new Map<number, ReplayBlockChunk>();
  const refs = chooseReplayRefs(keys);
  if (refs.length === 0) return found;
  await forEachReplayBlock(
    refs,
    (ref, lines) => {
      if (windowId !== undefined && ref.windowId !== windowId) return;
      for (const line of lines) {
        const head = parseReplayLineHead(line);
        if (!head) continue;
        if (windowId !== undefined && (head.window_id ?? '') !== windowId)
          continue;
        const key = keyFromLineHead(head);
        if (!key) continue;
        const seq = wanted.get(`${key.chunkIndex}\u0000${key.startedMs}`);
        if (seq === undefined || found.has(seq)) continue;
        let payload = '';
        try {
          payload = String(
            (JSON.parse(line) as { payload?: unknown }).payload ?? '',
          );
        } catch {
          payload = '';
        }
        found.set(seq, {
          seq,
          startedMs: key.startedMs,
          endedMs: key.endedMs,
          payload,
        });
      }
    },
    opts,
  );
  return found;
}

// `chunk_keys` exists only after migration 26. Probe once (re-probe a missing
// column every few minutes) so the reader works before and after the DDL.
let chunkKeysColumn: { present: boolean; at: number } | null = null;
const CHUNK_KEYS_REPROBE_MS = 5 * 60 * 1000;

export async function replayBlocksHaveChunkKeys(): Promise<boolean> {
  if (
    chunkKeysColumn &&
    (chunkKeysColumn.present ||
      Date.now() - chunkKeysColumn.at < CHUNK_KEYS_REPROBE_MS)
  ) {
    return chunkKeysColumn.present;
  }
  try {
    const rows = await chQuery<{ c: string | number }>(
      `SELECT count() AS c FROM system.columns
        WHERE database = currentDatabase()
          AND table = ${sqlstring.escape(TABLE_NAMES.session_replay_blocks)}
          AND name = 'chunk_keys'`,
    );
    chunkKeysColumn = { present: Number(rows[0]?.c ?? 0) > 0, at: Date.now() };
  } catch {
    chunkKeysColumn = { present: false, at: Date.now() };
  }
  return chunkKeysColumn.present;
}

type RefRow = {
  window_id: string;
  block_index: string | number;
  blob_path: string;
  byte_start: string | number;
  byte_end: string | number;
  created_ms: string | number;
  first_ms: string | number;
  last_ms?: string | number;
  events_count?: string | number;
  size_bytes?: string | number;
  chunk_keys?: [
    number | string,
    number | string,
    number | string,
    number | string,
  ][];
};

/** Every block ref of a session (ORDER BY prefix lookup; no FINAL needed). */
export async function fetchReplayBlockRefs(
  projectId: string,
  sessionId: string,
): Promise<ReplayBlockRef[]> {
  const withKeys = await replayBlocksHaveChunkKeys();
  const rows = await chQuery<RefRow>(
    `SELECT window_id,
            toString(block_index) AS block_index,
            blob_path,
            toString(byte_start) AS byte_start,
            toString(byte_end) AS byte_end,
            toString(toUnixTimestamp(created_at) * 1000) AS created_ms,
            toString(toUnixTimestamp64Milli(first_started_at)) AS first_ms,
            toString(toUnixTimestamp64Milli(last_started_at)) AS last_ms,
            toString(events_count) AS events_count,
            toString(size_bytes) AS size_bytes
            ${withKeys ? ', chunk_keys' : ''}
     FROM ${TABLE_NAMES.session_replay_blocks}
     WHERE project_id = ${sqlstring.escape(projectId)}
       AND session_id = ${sqlstring.escape(sessionId)}
     ORDER BY block_index, byte_start`,
  );
  return rows
    .map((r) => ({
      windowId: r.window_id ?? '',
      blockIndex: Number(r.block_index),
      blobPath: r.blob_path,
      byteStart: Number(r.byte_start),
      byteEnd: Number(r.byte_end),
      createdAtMs: Number(r.created_ms),
      firstStartedMs: Number(r.first_ms),
      lastStartedMs: (() => {
        const last = Number(r.last_ms);
        return Number.isFinite(last) ? last : Number(r.first_ms);
      })(),
      eventsCount: Number(r.events_count) || 0,
      sizeBytes:
        Number(r.size_bytes) || Number(r.byte_end) - Number(r.byte_start),
      chunkKeys: (r.chunk_keys ?? []).map(
        ([c, s, e, f]) =>
          [Number(c), Number(s), Number(e), Number(f)] as ReplayBlockChunkKey,
      ),
    }))
    .filter((r) => r.blobPath && r.byteEnd > r.byteStart);
}

/** SELECT of session ids that have block refs, for presence/list subqueries. */
export function replayBlockSessionIdsSql(
  projectId: string,
  windowWhere?: string,
): string {
  return `SELECT DISTINCT session_id
      FROM ${TABLE_NAMES.session_replay_blocks}
      WHERE project_id = ${sqlstring.escape(projectId)}
        ${windowWhere ? `AND ${windowWhere}` : ''}`;
}
