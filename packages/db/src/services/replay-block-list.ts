/**
 * Session replay serving, PostHog style: a cheap BLOCK LIST, then raw BLOCK
 * DATA fetched in small batches by the player.
 *
 *   session.replayBlocks (tRPC)  ->  getReplayBlockList()
 *   GET /replay/blocks (Fastify) ->  prepareReplayBlockData() + run()
 *
 * Source decision: decideReplayServing() (session.service.ts), unchanged:
 * 'blocks' only for allow-listed projects whose refs are provably complete,
 * else legacy ('ch' hot table first, else the 'blob' cold archive). One source
 * per session, never mixed; a data request names the source it was listed
 * with and is refused (409) if the server now decides differently, so the
 * player never switches stores mid-session.
 *
 * 'blocks': the list is built straight from `session_replay_blocks` refs
 * (first/last_started_at, events_count, size_bytes); nothing is downloaded or
 * decoded. Duplicate refs (a redelivered Kafka batch appended again) stay
 * separate blocks; the player de-duplicates chunks. Data = each block's raw
 * zstd bytes exactly as stored (range GETs, adjacent ranges coalesced, bounded
 * concurrency, aborted with the request). No server-side decompression.
 *
 * legacy: pseudo-blocks = fixed pages of the session's ordered chunk keys (one
 * payload-free key query), with start/end from the keys, so the player sees
 * the same shape. Data = those chunks read via the legacy store, serialized to
 * the SAME NDJSON line format the Blob blocks hold and zstd-compressed, framed
 * identically: one decode path on the client.
 *
 * Framing: see @openpanel/common replay-frames.ts.
 */
import {
  encodeReplayFramePrefix,
  encodeReplayFramesHeader,
  encodeReplayFramesTerminator,
} from '@openpanel/common';
import { compressReplayBlock } from '../blob/replay-blocks';
import {
  type ReplayBlockRef,
  readReplayRefsRaw,
  replayActiveMs,
} from './replay-block-reader';
import {
  type LegacyReplayChunkKey,
  REPLAY_IDLE_GAP_MS,
  type ReplaySource,
  decideReplayServing,
  legacyChunkId,
  listLegacyReplayChunkKeys,
  readLegacyReplayChunkLines,
} from './session.service';

// --- Config -------------------------------------------------------------------

const positiveIntEnv = (name: string, fallback: number): number => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** PostHog's cap on blocks per data request. */
export const REPLAY_BLOCKS_MAX_PER_REQUEST = 100;
/** Live sessions grow, so the list is only cached briefly (PostHog: 5 s). */
export const REPLAY_BLOCK_LIST_TTL_MS = 5_000;
/**
 * A data request may reuse a resolution this old when it still knows every
 * requested key (refs are append-only); otherwise it re-resolves.
 */
const REPLAY_BLOCK_DATA_TTL_MS = 60_000;
const REPLAY_BLOCK_CACHE_MAX = 200;
/**
 * Chunks per legacy pseudo-block on the CH hot table: exactly one, not
 * configurable. A page's key is its first chunk, and the client keeps an
 * already-applied key as is on a re-list. A live tab's pages grow (the last
 * page goes 1 → 2 chunks) and a late chunk shifts page boundaries, so a
 * multi-chunk page changes content under an unchanged key and the new chunk is
 * never fetched. One chunk per page makes every key immutable: new chunks are
 * always new keys. (CH range reads are cheap, so the extra blocks cost little.)
 */
const LEGACY_CH_CHUNKS_PER_BLOCK = 1;
/**
 * Chunks per pseudo-block for the cold archive: every archive read downloads
 * the whole session file, so fewer, bigger pages (10 blocks = the old 50-chunk
 * page). Archived sessions are finished and immutable, so multi-chunk pages
 * are safe here (see LEGACY_CH_CHUNKS_PER_BLOCK).
 */
const LEGACY_BLOB_CHUNKS_PER_BLOCK = positiveIntEnv(
  'REPLAY_LEGACY_BLOCK_CHUNKS_BLOB',
  5,
);

// --- Types --------------------------------------------------------------------

export type ReplayBlockSource = 'blocks' | 'ch' | 'blob';

export interface ReplayBlockInfo {
  /** Position in the session's list (sorted by startMs). Informational. */
  index: number;
  /** Opaque, stable id of the block: what data requests ask for. */
  key: string;
  windowId: string;
  /** First chunk's start (Unix ms). */
  startMs: number;
  /**
   * Blocks: the START of the last chunk (refs carry no chunk end, so the last
   * chunk's own few seconds are not included). Legacy: the last chunk's end.
   */
  endMs: number;
  eventsCount: number;
  /** Stored (compressed) bytes; 0 when unknown (legacy). */
  sizeBytes: number;
}

export interface ReplayBlockWindowInfo {
  windowId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Span minus idle gaps (>= idleGapMs) between consecutive blocks/chunks. */
  activeMs: number;
  blockCount: number;
  eventsCount: number;
}

export interface ReplayBlockList {
  source: ReplayBlockSource;
  idleGapMs: number;
  windows: ReplayBlockWindowInfo[];
  blocks: ReplayBlockInfo[];
}

type LegacyPage = { windowId: string; chunks: LegacyReplayChunkKey[] };

type ResolvedEntry = {
  at: number;
  list: ReplayBlockList;
  internal:
    | { kind: 'blocks'; refsByKey: Map<string, ReplayBlockRef> }
    | {
        kind: 'ch' | 'blob';
        src: ReplaySource;
        /** `${windowId}\0${key}` -> the page's chunks */
        pages: Map<string, LegacyPage>;
      };
};

// --- Pure builders ------------------------------------------------------------

/** A ref's block key: Kafka first offset + byte offset (unique per append). */
export const replayRefKey = (ref: ReplayBlockRef): string =>
  `${ref.blockIndex}.${ref.byteStart}`;

const byStartThenWindow = (
  a: { startMs: number; windowId: string },
  b: { startMs: number; windowId: string },
) =>
  a.startMs - b.startMs ||
  (a.windowId < b.windowId ? -1 : a.windowId > b.windowId ? 1 : 0);

/**
 * Block list from refs, no decoding. Identical refs (the same row read twice
 * before ReplacingMergeTree merged) collapse; distinct appends of the same
 * chunks (redelivery) stay separate blocks.
 */
export function buildBlocksSourceList(refs: ReplayBlockRef[]): {
  blocks: ReplayBlockInfo[];
  refsByKey: Map<string, ReplayBlockRef>;
} {
  const refsByKey = new Map<string, ReplayBlockRef>();
  for (const ref of refs) {
    if (!(ref.byteEnd > ref.byteStart)) continue;
    const key = replayRefKey(ref);
    if (!refsByKey.has(key)) refsByKey.set(key, ref);
  }
  const blocks = Array.from(refsByKey.entries())
    .map(([key, ref]) => ({
      index: 0,
      key,
      windowId: ref.windowId,
      startMs: ref.firstStartedMs,
      endMs: Math.max(
        ref.firstStartedMs,
        Number.isFinite(ref.lastStartedMs)
          ? ref.lastStartedMs
          : ref.firstStartedMs,
      ),
      eventsCount: ref.eventsCount,
      sizeBytes: ref.byteEnd - ref.byteStart,
      blockIndex: ref.blockIndex,
      byteStart: ref.byteStart,
    }))
    .sort(
      (a, b) =>
        byStartThenWindow(a, b) ||
        a.blockIndex - b.blockIndex ||
        a.byteStart - b.byteStart,
    )
    .map(({ blockIndex: _b, byteStart: _s, ...block }, index) => ({
      ...block,
      index,
    }));
  return { blocks, refsByKey };
}

/** A legacy page's key: its first chunk (stable while chunks only append). */
export const legacyPageKey = (first: LegacyReplayChunkKey): string =>
  `c${first.startedMs}.${first.chunkIndex}`;

/**
 * Legacy pseudo-blocks: per window, consecutive pages of `chunksPerBlock`
 * chunk keys (keys already de-duplicated and ordered by (started_at,
 * chunk_index)). start/end/events from the keys.
 */
export function buildLegacyBlockList(
  keys: LegacyReplayChunkKey[],
  chunksPerBlock: number,
): { blocks: ReplayBlockInfo[]; pages: Map<string, LegacyPage> } {
  const perBlock = Math.max(1, Math.floor(chunksPerBlock));
  const byWindow = new Map<string, LegacyReplayChunkKey[]>();
  for (const k of keys) {
    const list = byWindow.get(k.windowId);
    if (list) list.push(k);
    else byWindow.set(k.windowId, [k]);
  }
  const pages = new Map<string, LegacyPage>();
  const unsorted: Omit<ReplayBlockInfo, 'index'>[] = [];
  for (const [windowId, list] of byWindow) {
    list.sort(
      (a, b) => a.startedMs - b.startedMs || a.chunkIndex - b.chunkIndex,
    );
    for (let i = 0; i < list.length; i += perBlock) {
      const chunks = list.slice(i, i + perBlock);
      const first = chunks[0]!;
      const key = legacyPageKey(first);
      let endMs = first.endedMs;
      let eventsCount = 0;
      for (const c of chunks) {
        endMs = Math.max(endMs, c.endedMs);
        eventsCount += c.eventsCount;
      }
      pages.set(`${windowId}\u0000${key}`, { windowId, chunks });
      unsorted.push({
        key,
        windowId,
        startMs: first.startedMs,
        endMs: Math.max(first.startedMs, endMs),
        eventsCount,
        sizeBytes: 0,
      });
    }
  }
  const blocks = unsorted
    .sort(byStartThenWindow)
    .map((b, index) => ({ ...b, index }));
  return { blocks, pages };
}

/**
 * Per-window summary from time spans (blocks, or legacy chunk keys): span,
 * idle-collapsed active time (replayActiveMs: same rule as the SQL readers),
 * counts. Ordered by start.
 */
export function computeBlockListWindows(
  spans: {
    windowId: string;
    startMs: number;
    endMs: number;
    eventsCount: number;
  }[],
  idleGapMs: number,
  blockCounts?: Map<string, number>,
): ReplayBlockWindowInfo[] {
  const byWindow = new Map<string, typeof spans>();
  for (const s of spans) {
    const list = byWindow.get(s.windowId);
    if (list) list.push(s);
    else byWindow.set(s.windowId, [s]);
  }
  const out: ReplayBlockWindowInfo[] = [];
  for (const [windowId, list] of byWindow) {
    list.sort((a, b) => a.startMs - b.startMs);
    let startMs = Number.POSITIVE_INFINITY;
    let endMs = Number.NEGATIVE_INFINITY;
    let eventsCount = 0;
    for (const s of list) {
      startMs = Math.min(startMs, s.startMs);
      endMs = Math.max(endMs, s.endMs);
      eventsCount += s.eventsCount;
    }
    out.push({
      windowId,
      startMs,
      endMs,
      durationMs: Math.max(0, endMs - startMs),
      activeMs: replayActiveMs(
        list.map((s) => ({ startedMs: s.startMs, endedMs: s.endMs })),
        idleGapMs,
      ),
      blockCount: blockCounts?.get(windowId) ?? list.length,
      eventsCount,
    });
  }
  return out.sort(byStartThenWindow);
}

function countByWindow(blocks: ReplayBlockInfo[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of blocks) m.set(b.windowId, (m.get(b.windowId) ?? 0) + 1);
  return m;
}

// --- Resolution + cache -------------------------------------------------------

const cache = new Map<string, ResolvedEntry>();
const inFlight = new Map<string, Promise<ResolvedEntry>>();

function cacheEntry(key: string, entry: ResolvedEntry) {
  cache.delete(key);
  if (cache.size >= REPLAY_BLOCK_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
}

/** Test hook. */
export function __clearReplayBlockListCache(): void {
  cache.clear();
  inFlight.clear();
}

async function buildEntry(
  sessionId: string,
  projectId: string,
  signal?: AbortSignal | null,
): Promise<ResolvedEntry> {
  const decision = await decideReplayServing(sessionId, projectId, { signal });
  if (decision.kind === 'blocks') {
    const { blocks, refsByKey } = buildBlocksSourceList(decision.refs);
    return {
      at: Date.now(),
      list: {
        source: 'blocks',
        idleGapMs: REPLAY_IDLE_GAP_MS,
        windows: computeBlockListWindows(blocks, REPLAY_IDLE_GAP_MS),
        blocks,
      },
      internal: { kind: 'blocks', refsByKey },
    };
  }
  const src = decision.legacy;
  const keys = await listLegacyReplayChunkKeys(src, sessionId, projectId);
  const { blocks, pages } = buildLegacyBlockList(
    keys,
    src.kind === 'blob'
      ? LEGACY_BLOB_CHUNKS_PER_BLOCK
      : LEGACY_CH_CHUNKS_PER_BLOCK,
  );
  return {
    at: Date.now(),
    list: {
      source: src.kind,
      idleGapMs: REPLAY_IDLE_GAP_MS,
      // Chunk-level spans: identical to getSessionWindows' active time.
      windows: computeBlockListWindows(
        keys.map((k) => ({
          windowId: k.windowId,
          startMs: k.startedMs,
          endMs: k.endedMs,
          eventsCount: k.eventsCount,
        })),
        REPLAY_IDLE_GAP_MS,
        countByWindow(blocks),
      ),
      blocks,
    },
    internal: { kind: src.kind, src, pages },
  };
}

async function resolveEntry(
  sessionId: string,
  projectId: string,
  opts: { maxAgeMs: number; signal?: AbortSignal | null },
): Promise<ResolvedEntry> {
  const key = `${projectId}\u0000${sessionId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at <= opts.maxAgeMs) return hit;
  // Share one resolution between concurrent callers (list + first data
  // request). The shared build is not tied to any one caller's signal.
  let pending = inFlight.get(key);
  if (!pending) {
    pending = buildEntry(sessionId, projectId)
      .then((entry) => {
        cacheEntry(key, entry);
        return entry;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return abortable(pending, opts.signal);
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function abortError(): Error {
  const err = new Error('replay request aborted');
  err.name = 'AbortError';
  return err;
}

/** The session's block list (cached REPLAY_BLOCK_LIST_TTL_MS). */
export async function getReplayBlockList(
  sessionId: string,
  projectId: string,
  opts: { signal?: AbortSignal | null } = {},
): Promise<ReplayBlockList> {
  const entry = await resolveEntry(sessionId, projectId, {
    maxAgeMs: REPLAY_BLOCK_LIST_TTL_MS,
    signal: opts.signal,
  });
  return entry.list;
}

// --- Block data ---------------------------------------------------------------

export class ReplayBlockRequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'ReplayBlockRequestError';
  }
}

export type ReplayFrameWriter = (bytes: Uint8Array) => void | Promise<void>;

export interface PreparedReplayBlockData {
  source: ReplayBlockSource;
  blockCount: number;
  /**
   * Writes the framed response (header, one frame per requested block in any
   * order, terminator). Rejects on a read failure (the caller ends the
   * response without the terminator, so the client sees a truncated body)
   * or with an AbortError when the signal fires.
   */
  run: (write: ReplayFrameWriter) => Promise<void>;
}

function knowsAll(
  entry: ResolvedEntry,
  windowId: string,
  keys: string[],
): boolean {
  const { internal } = entry;
  if (internal.kind === 'blocks') {
    return keys.every((k) => {
      const ref = internal.refsByKey.get(k);
      return ref !== undefined && ref.windowId === windowId;
    });
  }
  return keys.every((k) => internal.pages.has(`${windowId}\u0000${k}`));
}

/**
 * Validate a data request and resolve its blocks. Throws
 * ReplayBlockRequestError (nothing written yet): 400 bad input, 409 when the
 * session's source changed or a key is unknown (stale list: the client
 * re-lists). The returned `run` streams the frames.
 */
export async function prepareReplayBlockData(input: {
  sessionId: string;
  projectId: string;
  windowId: string;
  source: string;
  keys: string[];
  signal?: AbortSignal | null;
}): Promise<PreparedReplayBlockData> {
  const keys = Array.from(new Set(input.keys.filter(Boolean)));
  if (keys.length === 0) {
    throw new ReplayBlockRequestError(400, 'no block keys requested');
  }
  if (keys.length > REPLAY_BLOCKS_MAX_PER_REQUEST) {
    throw new ReplayBlockRequestError(
      400,
      `at most ${REPLAY_BLOCKS_MAX_PER_REQUEST} blocks per request`,
    );
  }
  if (!['blocks', 'ch', 'blob'].includes(input.source)) {
    throw new ReplayBlockRequestError(400, 'unknown source');
  }
  let entry = await resolveEntry(input.sessionId, input.projectId, {
    maxAgeMs: REPLAY_BLOCK_DATA_TTL_MS,
    signal: input.signal,
  });
  if (
    entry.list.source !== input.source ||
    !knowsAll(entry, input.windowId, keys)
  ) {
    entry = await resolveEntry(input.sessionId, input.projectId, {
      maxAgeMs: 0,
      signal: input.signal,
    });
  }
  if (entry.list.source !== input.source) {
    throw new ReplayBlockRequestError(
      409,
      `replay source changed (${input.source} -> ${entry.list.source}); reload the block list`,
    );
  }
  if (!knowsAll(entry, input.windowId, keys)) {
    throw new ReplayBlockRequestError(
      409,
      'unknown block key for this window; reload the block list',
    );
  }

  const signal = input.signal ?? undefined;
  const { internal } = entry;
  if (internal.kind === 'blocks') {
    const refs = keys.map((k) => internal.refsByKey.get(k)!);
    return {
      source: 'blocks',
      blockCount: refs.length,
      run: async (write) => {
        await write(encodeReplayFramesHeader());
        await readReplayRefsRaw(
          refs,
          // One write per frame (prefix + bytes together) so concurrent
          // GETs can never interleave two frames.
          (ref, bytes) =>
            write(
              Buffer.concat([
                encodeReplayFramePrefix(replayRefKey(ref), bytes.length),
                bytes,
              ]),
            ),
          { signal },
        );
        await write(encodeReplayFramesTerminator());
      },
    };
  }

  const pages = keys.map((k) => ({
    key: k,
    page: internal.pages.get(`${input.windowId}\u0000${k}`)!,
  }));
  // Read the chunks BEFORE streaming starts (run holds them all anyway): a
  // listed chunk that is gone now (CH delete cron / TTL between the list and
  // this read) must fail with 409 so the client re-lists. Sent without it,
  // the client would mark the block loaded and never fetch it again.
  const lines = await readLegacyReplayChunkLines(
    internal.src,
    input.sessionId,
    input.projectId,
    input.windowId,
    pages.flatMap(({ page }) =>
      page.chunks.map((c) => ({
        chunkIndex: c.chunkIndex,
        startedMs: c.startedMs,
      })),
    ),
    { signal },
  );
  for (const { page } of pages) {
    for (const c of page.chunks) {
      if (!lines.has(legacyChunkId(c.chunkIndex, c.startedMs))) {
        throw new ReplayBlockRequestError(
          409,
          'a listed chunk is no longer stored; reload the block list',
        );
      }
    }
  }
  return {
    source: internal.kind,
    blockCount: pages.length,
    run: async (write) => {
      await write(encodeReplayFramesHeader());
      for (const { key, page } of pages) {
        const blockLines = page.chunks.map(
          (c) => lines.get(legacyChunkId(c.chunkIndex, c.startedMs))!,
        );
        const data = compressReplayBlock(blockLines);
        await write(
          Buffer.concat([encodeReplayFramePrefix(key, data.length), data]),
        );
      }
      await write(encodeReplayFramesTerminator());
    },
  };
}
