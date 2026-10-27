import type { DecodedBlock, DecodedChunk } from './replay-block-decode';

/** One block of the playing window, as listed by session.replayBlocks. */
export type ReplayBlockMeta = {
  key: string;
  windowId: string;
  startMs: number;
  endMs: number;
  eventsCount: number;
  sizeBytes: number;
};

/**
 * unloaded -> loading (request in flight) -> loaded (decoded, waiting to be
 * handed to rrweb) -> applied (its events are in the player).
 * A failed or cancelled request puts its blocks back to unloaded.
 */
export type ReplayBlockState = 'unloaded' | 'loading' | 'loaded' | 'applied';

export interface ReplayBlockEntry {
  meta: ReplayBlockMeta;
  pos: number;
  state: ReplayBlockState;
  /** FullSnapshot timestamps (known once loaded). */
  fullSnapshots: number[];
  /** Latest event timestamp once loaded (refines meta.endMs). */
  maxTs: number | null;
  /** Decoded chunks kept only between load and apply. */
  chunks: DecodedChunk[] | null;
}

const isIn = (s: ReplayBlockState) => s === 'loaded' || s === 'applied';

/**
 * The player's view of one window's blocks (PostHog SnapshotStore, adapted):
 * blocks ordered by start, their load state and the FullSnapshots found in the
 * loaded ones. Pure bookkeeping: no I/O, no rrweb.
 *
 * "Playable at t" (canPlayAt) needs the latest FullSnapshot at or before t and
 * every block between it and t in the player. Blocks may overlap in time (a
 * redelivered batch, a late SDK retry), so a block that starts before the
 * snapshot but reaches past it counts too.
 */
export class ReplayBlockStore {
  private entries: ReplayBlockEntry[] = [];
  version = 0;

  constructor(blocks: ReplayBlockMeta[] = []) {
    this.setBlocks(blocks);
  }

  /**
   * (Re)set the block list. Entries already known by key keep their state and
   * data (a live session's list grows; a re-list must not drop loaded data).
   */
  setBlocks(blocks: ReplayBlockMeta[]): void {
    const byKey = new Map(this.entries.map((e) => [e.meta.key, e]));
    const sorted = [...blocks].sort(
      (a, b) => a.startMs - b.startMs || (a.key < b.key ? -1 : 1),
    );
    this.entries = sorted.map((meta, pos) => {
      const existing = byKey.get(meta.key);
      if (existing) {
        existing.meta = meta;
        existing.pos = pos;
        return existing;
      }
      return {
        meta,
        pos,
        state: 'unloaded' as const,
        fullSnapshots: [],
        maxTs: null,
        chunks: null,
      };
    });
    this.version++;
  }

  get count(): number {
    return this.entries.length;
  }

  entry(pos: number): ReplayBlockEntry | undefined {
    return this.entries[pos];
  }

  get allApplied(): boolean {
    return this.entries.every((e) => e.state === 'applied');
  }

  get firstStartMs(): number | null {
    return this.entries[0]?.meta.startMs ?? null;
  }

  /** meta.endMs, extended to the latest event once the block is loaded. */
  endOf(e: ReplayBlockEntry): number {
    return e.maxTs != null ? Math.max(e.meta.endMs, e.maxTs) : e.meta.endMs;
  }

  /**
   * The block whose span holds `ts`, else the nearest one before it (or the
   * first block). null only when there are no blocks: callers must not treat
   * that as block 0.
   */
  indexForTimestamp(ts: number): number | null {
    if (this.entries.length === 0) return null;
    let lo = 0;
    let hi = this.entries.length - 1;
    let candidate = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid]!.meta.startMs <= ts) {
        candidate = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return Math.max(0, candidate);
  }

  /** Latest loaded FullSnapshot at or before `ts`. */
  findNearestFullSnapshot(ts: number): { pos: number; ts: number } | null {
    let best: { pos: number; ts: number } | null = null;
    for (const e of this.entries) {
      if (e.pos > 0 && e.meta.startMs > ts) break;
      if (!isIn(e.state)) continue;
      for (const fs of e.fullSnapshots) {
        if (fs <= ts && (!best || fs > best.ts)) best = { pos: e.pos, ts: fs };
      }
    }
    return best;
  }

  hasFullSnapshotAfter(ts: number): boolean {
    for (const e of this.entries) {
      if (!isIn(e.state)) continue;
      if (e.fullSnapshots.some((fs) => fs >= ts)) return true;
    }
    return false;
  }

  private ready(e: ReplayBlockEntry, applied: boolean): boolean {
    return applied ? e.state === 'applied' : isIn(e.state);
  }

  /**
   * Can the player render `ts`? (`applied: false` asks whether the DATA is
   * here, loaded or applied: used before the player exists.)
   */
  canPlayAt(ts: number, opts: { applied?: boolean } = {}): boolean {
    const applied = opts.applied ?? true;
    const fs = this.findNearestFullSnapshot(ts);
    if (!fs) return false;
    const target = this.indexForTimestamp(ts);
    if (target === null) return false;
    for (let i = fs.pos; i <= target; i++) {
      if (!this.ready(this.entries[i]!, applied)) return false;
    }
    for (let i = 0; i < fs.pos; i++) {
      const e = this.entries[i]!;
      if (this.endOf(e) >= fs.ts && !this.ready(e, applied)) return false;
    }
    return true;
  }

  /**
   * Where buffering ahead of `ts` starts: indexForTimestamp, or an earlier
   * still-unrequested block that reaches `ts` (overlapping spans), which the
   * player needs as much as the ones after it.
   */
  anchorIndexFor(ts: number): number | null {
    const idx = this.indexForTimestamp(ts);
    if (idx === null) return null;
    for (let i = 0; i < idx; i++) {
      const e = this.entries[i]!;
      if (e.state === 'unloaded' && this.endOf(e) >= ts) return i;
    }
    return idx;
  }

  /** Positions in [start, end] not yet requested. */
  unfetchedInRange(start: number, end: number): number[] {
    const out: number[] = [];
    const lo = Math.max(0, start);
    const hi = Math.min(this.entries.length - 1, end);
    for (let i = lo; i <= hi; i++) {
      if (this.entries[i]!.state === 'unloaded') out.push(i);
    }
    return out;
  }

  /** Every block in [start, end] has its data here (loaded or applied). */
  isSettled(start: number, end: number): boolean {
    const lo = Math.max(0, start);
    const hi = Math.min(this.entries.length - 1, end);
    for (let i = lo; i <= hi; i++) {
      if (!isIn(this.entries[i]!.state)) return false;
    }
    return true;
  }

  /**
   * Current position of a block key. Positions are reassigned whenever the
   * list is re-set (a live recording re-lists every few seconds, and a late
   * block can sort before earlier ones), so an in-flight request must resolve
   * its keys to positions on completion, never reuse the positions it
   * captured when it started.
   */
  posOfKey(key: string): number | undefined {
    const e = this.entries.find((x) => x.meta.key === key);
    return e?.pos;
  }

  /** A failed / cancelled request, by key: its blocks can be requested again. */
  markUnloadedKeys(keys: string[]): void {
    const positions: number[] = [];
    for (const k of keys) {
      const p = this.posOfKey(k);
      if (p !== undefined) positions.push(p);
    }
    this.markUnloaded(positions);
  }

  markLoading(positions: number[]): void {
    for (const p of positions) {
      const e = this.entries[p];
      if (e && e.state === 'unloaded') e.state = 'loading';
    }
    this.version++;
  }

  /** A failed / cancelled request: its blocks can be requested again. */
  markUnloaded(positions: number[]): void {
    for (const p of positions) {
      const e = this.entries[p];
      if (e && e.state === 'loading') e.state = 'unloaded';
    }
    this.version++;
  }

  markLoaded(pos: number, block: DecodedBlock): void {
    const e = this.entries[pos];
    if (!e || isIn(e.state)) return;
    e.state = 'loaded';
    e.chunks = block.chunks;
    e.fullSnapshots = [...block.fullSnapshots].sort((a, b) => a - b);
    e.maxTs = block.maxTs;
    this.version++;
  }

  /** Loaded, not yet applied, in position (time) order. */
  pendingApply(): ReplayBlockEntry[] {
    return this.entries.filter((e) => e.state === 'loaded');
  }

  /** Hand a loaded block's chunks over (they are dropped from the store). */
  takeChunks(pos: number): DecodedChunk[] {
    const e = this.entries[pos];
    if (!e || e.state !== 'loaded') return [];
    const chunks = e.chunks ?? [];
    e.chunks = null;
    e.state = 'applied';
    this.version++;
    return chunks;
  }

  /**
   * The contiguous loaded prefix from block 0, for constructing the player:
   * its positions, and whether it holds a FullSnapshot. null if block 0 is
   * not loaded.
   */
  loadedPrefix(): { positions: number[]; hasFullSnapshot: boolean } | null {
    const positions: number[] = [];
    let hasFullSnapshot = false;
    for (const e of this.entries) {
      if (!isIn(e.state)) break;
      positions.push(e.pos);
      if (e.fullSnapshots.length > 0) hasFullSnapshot = true;
    }
    return positions.length > 0 ? { positions, hasFullSnapshot } : null;
  }

  /**
   * How far from `ts` the player can run before it needs a block it does not
   * have (applied): the start of the earliest not-applied block still
   * reaching `ts` or later. Infinity when everything ahead is in the player.
   */
  playableUntil(ts: number): number {
    let horizon = Number.POSITIVE_INFINITY;
    for (const e of this.entries) {
      if (e.state === 'applied') continue;
      if (this.endOf(e) < ts) continue;
      if (e.meta.startMs < horizon) horizon = e.meta.startMs;
    }
    return horizon;
  }

  /** Start of the first block starting after `ts` (skip-inactivity jumps). */
  nextBlockStartAfter(ts: number): number | null {
    for (const e of this.entries) {
      if (e.meta.startMs > ts) return e.meta.startMs;
    }
    return null;
  }

  /**
   * Buffered spans (absolute ms) for the progress bar: runs of consecutive
   * blocks whose data is here.
   */
  loadedRanges(): { startMs: number; endMs: number }[] {
    const out: { startMs: number; endMs: number }[] = [];
    let run: { startMs: number; endMs: number } | null = null;
    for (const e of this.entries) {
      if (!isIn(e.state)) {
        run = null;
        continue;
      }
      if (!run) {
        run = { startMs: e.meta.startMs, endMs: this.endOf(e) };
        out.push(run);
      } else {
        run.endMs = Math.max(run.endMs, this.endOf(e));
      }
    }
    return out;
  }
}

/** Server default (session.replayBlocks sends its own `idleGapMs`). */
export const DEFAULT_IDLE_GAP_MS = 15_000;

/**
 * Active recording segments of a window from its block spans: blocks whose
 * start is within `idleGapMs` of the running end merge; a larger gap is idle
 * air, collapsed on the scrubber. Same rule as getSessionWindowSegments, at
 * block granularity, so the full timeline shows before any data loads.
 */
export function computeBlockSegments(
  blocks: Pick<ReplayBlockMeta, 'startMs' | 'endMs'>[],
  idleGapMs: number,
): { startMs: number; endMs: number }[] {
  const sorted = [...blocks].sort((a, b) => a.startMs - b.startMs);
  const segments: { startMs: number; endMs: number }[] = [];
  for (const b of sorted) {
    const startMs = b.startMs;
    const endMs = Math.max(startMs, b.endMs);
    const last = segments[segments.length - 1];
    if (last && startMs - last.endMs < idleGapMs) {
      if (endMs > last.endMs) last.endMs = endMs;
    } else {
      segments.push({ startMs, endMs });
    }
  }
  return segments;
}
