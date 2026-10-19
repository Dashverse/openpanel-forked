import { decodeReplayFrames } from '@openpanel/common';

/**
 * Decoding of the replay block data endpoint (GET /replay/blocks), shared by
 * the Web Worker (replay-decode.worker.ts) and the main-thread fallback. Pure:
 * the zstd decompressor is injected (fzstd in the app, node:zlib in tests).
 *
 * A block is one zstd frame of NDJSON lines; each line is a replay chunk row
 * ({window_id, chunk_index, started_at, ended_at, is_full_snapshot, payload})
 * whose `payload` is a JSON array of rrweb events.
 *
 * De-duplication happens at two levels (PostHog style):
 *   - chunks: identity = (window_id, chunk_index, started_at). Within a block
 *     here; ACROSS blocks (a redelivered batch appended again = a second block
 *     holding the same chunks) by the player via `mergeChunkEvents` and its
 *     per-window `seen` set.
 *   - events: inside a block, events are sorted by timestamp and, among events
 *     sharing a timestamp, exact duplicates (same JSON minus `delay`, cyrb53
 *     hash, as in PostHog's process-all-snapshots) are dropped.
 */

export type ReplayEvent = {
  type: number;
  data: unknown;
  timestamp: number;
  delay?: number;
};

export interface DecodedChunk {
  /** `${windowId}|${chunkIndex}|${startedMs}`: the chunk's identity. */
  id: string;
  chunkIndex: number;
  startedMs: number;
  endedMs: number;
  /** Sorted by timestamp. */
  events: ReplayEvent[];
}

export interface DecodedBlock {
  chunks: DecodedChunk[];
  /** Timestamps of FullSnapshot (rrweb type 2) events in this block. */
  fullSnapshots: number[];
  /** Earliest / latest event timestamp (null when the block had none). */
  minTs: number | null;
  maxTs: number | null;
}

/** rrweb EventType.FullSnapshot */
export const RRWEB_FULL_SNAPSHOT = 2;

const CH_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * A chunk's started_at / ended_at as Unix ms, with the same rules the server
 * uses (replay-block.service parseReplayTimestampMs): ISO or
 * 'YYYY-MM-DD hh:mm:ss[.fff]' with no zone = UTC, numbers = Unix seconds.
 */
export function parseReplayTimestampMs(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.floor(value * 1000) : Number.NaN;
  }
  if (typeof value !== 'string') return Number.NaN;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.floor(Number(v) * 1000);
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

/*
 * cyrb53 (c) 2018 bryc (github.com/bryc). Public domain. A fast 53-bit string
 * hash; PostHog uses it to spot duplicate snapshots.
 */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function hashReplayEvent(event: ReplayEvent): number {
  const { delay: _delay, ...rest } = event;
  return cyrb53(JSON.stringify(rest));
}

const isEvent = (e: unknown): e is ReplayEvent =>
  !!e &&
  typeof e === 'object' &&
  typeof (e as ReplayEvent).type === 'number' &&
  typeof (e as ReplayEvent).timestamp === 'number' &&
  Number.isFinite((e as ReplayEvent).timestamp);

/**
 * Sort + PostHog duplicate removal over one list of events: only events that
 * share a timestamp are hashed and compared, so the common case costs one sort.
 * `owners[i]` is carried along so callers can rebuild per-chunk lists.
 */
export function sortAndDedupeEvents<T>(
  events: ReplayEvent[],
  owners?: T[],
): { events: ReplayEvent[]; owners: T[] } {
  const idx = events.map((_, i) => i);
  idx.sort((a, b) => events[a]!.timestamp - events[b]!.timestamp || a - b);
  const outEvents: ReplayEvent[] = [];
  const outOwners: T[] = [];
  let runTs = Number.NaN;
  let runHashes: Set<number> | null = null;
  let runFirst: ReplayEvent | null = null;
  for (const i of idx) {
    const ev = events[i]!;
    if (ev.timestamp === runTs) {
      if (!runHashes) {
        runHashes = new Set([hashReplayEvent(runFirst!)]);
      }
      const h = hashReplayEvent(ev);
      if (runHashes.has(h)) continue;
      runHashes.add(h);
    } else {
      runTs = ev.timestamp;
      runHashes = null;
      runFirst = ev;
    }
    outEvents.push(ev);
    if (owners) outOwners.push(owners[i]!);
  }
  return { events: outEvents, owners: outOwners };
}

/** NDJSON lines of one decompressed block (empty lines dropped). */
export function splitReplayLines(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const l of lines) if (l.length > 0) out.push(l);
  return out;
}

type ChunkRow = {
  window_id?: unknown;
  chunk_index?: unknown;
  started_at?: unknown;
  ended_at?: unknown;
  payload?: unknown;
};

/**
 * One block's lines -> its chunks of `windowId` (lines of other windows are
 * skipped; `windowId` undefined keeps all), chunk-deduped within the block,
 * events sorted and same-timestamp duplicates removed across the block.
 */
export function decodeReplayBlockLines(
  lines: string[],
  windowId?: string,
): DecodedBlock {
  const chunks: DecodedChunk[] = [];
  const seen = new Set<string>();
  const allEvents: ReplayEvent[] = [];
  const owners: number[] = [];
  for (const line of lines) {
    let row: ChunkRow;
    try {
      row = JSON.parse(line) as ChunkRow;
    } catch {
      continue;
    }
    const w = typeof row.window_id === 'string' ? row.window_id : '';
    if (windowId !== undefined && w !== windowId) continue;
    const chunkIndex = Number(row.chunk_index) || 0;
    const startedMs = parseReplayTimestampMs(row.started_at);
    if (!Number.isFinite(startedMs)) continue;
    const endedRaw = parseReplayTimestampMs(row.ended_at);
    const id = `${w}|${chunkIndex}|${startedMs}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let events: unknown = [];
    try {
      events =
        typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    } catch {
      events = [];
    }
    const chunkPos = chunks.length;
    chunks.push({
      id,
      chunkIndex,
      startedMs,
      endedMs: Number.isFinite(endedRaw)
        ? Math.max(startedMs, endedRaw)
        : startedMs,
      events: [],
    });
    if (Array.isArray(events)) {
      for (const e of events) {
        if (!isEvent(e)) continue;
        allEvents.push(e);
        owners.push(chunkPos);
      }
    }
  }
  const deduped = sortAndDedupeEvents(allEvents, owners);
  const fullSnapshots: number[] = [];
  deduped.events.forEach((ev, i) => {
    chunks[deduped.owners[i]!]!.events.push(ev);
    if (ev.type === RRWEB_FULL_SNAPSHOT) fullSnapshots.push(ev.timestamp);
  });
  const first = deduped.events[0];
  const last = deduped.events[deduped.events.length - 1];
  return {
    chunks,
    fullSnapshots,
    minTs: first ? first.timestamp : null,
    maxTs: last ? last.timestamp : null,
  };
}

const textDecoder = new TextDecoder();

/**
 * A whole framed response -> decoded blocks by key. Throws on a malformed or
 * truncated body (the request is then treated as failed and retried).
 */
export function decodeReplayBlocksResponse(
  body: Uint8Array,
  decompress: (data: Uint8Array) => Uint8Array,
  windowId?: string,
): Map<string, DecodedBlock> {
  const out = new Map<string, DecodedBlock>();
  for (const frame of decodeReplayFrames(body)) {
    const text =
      frame.data.length === 0 ? '' : textDecoder.decode(decompress(frame.data));
    out.set(
      frame.key,
      decodeReplayBlockLines(splitReplayLines(text), windowId),
    );
  }
  return out;
}

/**
 * Events to hand to rrweb for a set of newly loaded chunks: chunks already
 * applied (same identity, from another block) are skipped and recorded in
 * `seen`; the rest are merged into one timestamp-sorted list with the same
 * duplicate removal as within a block.
 */
export function mergeChunkEvents(
  chunks: DecodedChunk[],
  seen: Set<string>,
): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  for (const c of chunks) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    for (const e of c.events) events.push(e);
  }
  return sortAndDedupeEvents(events).events;
}
