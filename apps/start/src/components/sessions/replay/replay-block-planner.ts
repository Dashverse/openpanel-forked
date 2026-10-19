import type { ReplayBlockStore } from './replay-block-store';

/**
 * Progressive replay loading: the pure planner, ported from PostHog's
 * planNextBatch (frontend/.../snapshot-store/planNextBatch.ts). Recomputed from
 * scratch on every tick, so it carries no cursors or modes and converges
 * because the store's requested set only grows.
 *
 *  - buffer ahead: keep the next `bufferAhead` blocks from the playhead
 *    requested, `batchSize` at a time;
 *  - seek to t (not playable yet): load `seekBehind` / `seekAhead` blocks
 *    around t's block, then backfill toward the nearest loaded FullSnapshot
 *    (closest to t first), else hunt backward for one, else forward until a
 *    FullSnapshot after t is known;
 *  - a batch is always a contiguous run of positions (one request).
 */
export const REPLAY_PLANNER_DEFAULTS = {
  batchSize: 10,
  bufferAhead: 30,
  seekBehind: 3,
  seekAhead: 7,
} as const;

export type ReplayPlannerConfig = {
  [K in keyof typeof REPLAY_PLANNER_DEFAULTS]: number;
};

export type LoadBatchReason =
  | 'seek_target'
  | 'seek_gap_fill'
  | 'seek_backward'
  | 'seek_forward'
  | 'buffer_ahead';

export type LoadBatch = { positions: number[]; reason: LoadBatchReason };

export type PlanInput = {
  /** A position the player wants to show but cannot yet (pending seek). */
  target: number | null;
  /** Where playback is (absolute ms); undefined = the recording start. */
  playbackPosition?: number;
};

export function planNextBatch(
  store: ReplayBlockStore,
  { target, playbackPosition }: PlanInput,
  config: ReplayPlannerConfig = REPLAY_PLANNER_DEFAULTS,
): LoadBatch | null {
  if (store.count === 0) return null;
  if (target !== null && !store.canPlayAt(target, { applied: false })) {
    const seek = planSeekBatch(store, target, config);
    if (seek) return seek;
  }
  return planBufferAhead(
    store,
    config,
    playbackPosition ?? target ?? undefined,
  );
}

function planSeekBatch(
  store: ReplayBlockStore,
  timestamp: number,
  config: ReplayPlannerConfig,
): LoadBatch | null {
  const targetIndex = store.indexForTimestamp(timestamp);
  if (targetIndex === null) return null;
  const windowStart = Math.max(0, targetIndex - config.seekBehind);
  const windowEnd = Math.min(store.count - 1, targetIndex + config.seekAhead);

  // 1. The window around the target.
  const inWindow = store.unfetchedInRange(windowStart, windowEnd);
  if (inWindow.length > 0) {
    return {
      positions: contiguous(inWindow.slice(0, config.batchSize)),
      reason: 'seek_target',
    };
  }

  // 2. The span between the nearest FullSnapshot and the target, closest to
  //    the target first.
  const nearest = store.findNearestFullSnapshot(timestamp);
  if (nearest) {
    const gap = store.unfetchedInRange(nearest.pos, targetIndex);
    if (gap.length > 0) {
      return {
        positions: contiguousFromEnd(gap.slice(-config.batchSize)),
        reason: 'seek_gap_fill',
      };
    }
    return null;
  }

  // 3. No FullSnapshot at/before the target loaded: hunt backward, closest
  //    blocks first.
  const backward = store.unfetchedInRange(0, windowStart - 1);
  if (backward.length > 0) {
    return {
      positions: contiguousFromEnd(backward.slice(-config.batchSize)),
      reason: 'seek_backward',
    };
  }

  // 4. Nothing before the target can help: load forward until a FullSnapshot
  //    after it is known (the player then starts there).
  if (!store.hasFullSnapshotAfter(timestamp)) {
    const forward = store.unfetchedInRange(windowEnd + 1, store.count - 1);
    if (forward.length > 0) {
      return {
        positions: contiguous(forward.slice(0, config.batchSize)),
        reason: 'seek_forward',
      };
    }
  }
  return null;
}

function planBufferAhead(
  store: ReplayBlockStore,
  config: ReplayPlannerConfig,
  playbackPosition?: number,
): LoadBatch | null {
  let anchor = 0;
  if (playbackPosition !== undefined) {
    const idx = store.anchorIndexFor(playbackPosition);
    if (idx === null) return null;
    anchor = idx;
  }
  const bufferEnd = Math.min(store.count - 1, anchor + config.bufferAhead - 1);
  const ahead = store.unfetchedInRange(anchor, bufferEnd);
  if (ahead.length > 0) {
    return {
      positions: contiguous(ahead.slice(0, config.batchSize)),
      reason: 'buffer_ahead',
    };
  }
  // A playhead with no usable FullSnapshot before it and none loaded after it
  // can't progress: scan forward until a recovery FullSnapshot is known.
  if (
    playbackPosition !== undefined &&
    store.findNearestFullSnapshot(playbackPosition) === null &&
    !store.hasFullSnapshotAfter(playbackPosition)
  ) {
    const forward = store.unfetchedInRange(bufferEnd + 1, store.count - 1);
    if (forward.length > 0) {
      return {
        positions: contiguous(forward.slice(0, config.batchSize)),
        reason: 'seek_forward',
      };
    }
  }
  return null;
}

/** Leading contiguous run (ascending positions). */
function contiguous(positions: number[]): number[] {
  if (positions.length <= 1) return positions;
  const out = [positions[0]!];
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] !== positions[i - 1]! + 1) break;
    out.push(positions[i]!);
  }
  return out;
}

/**
 * Trailing contiguous run: the run touching the END of `positions` (the part
 * closest to the target when backfilling), kept in ascending order.
 * PostHog truncates from the front here, which can pick a run far from the
 * target when the backfill range has holes; closest-first wants the tail.
 */
function contiguousFromEnd(positions: number[]): number[] {
  if (positions.length <= 1) return positions;
  let start = positions.length - 1;
  while (start > 0 && positions[start - 1] === positions[start]! - 1) start--;
  return positions.slice(start);
}

// --- Playback buffering (stall / resume) ------------------------------------

export const PLAYBACK_DEFAULTS = {
  /** Stall when this little (x speed) is left before a missing block. */
  starveMarginMs: 500,
  /** After a stall, resume once this much (x speed) is playable. */
  resumeAheadMs: 10_000,
} as const;

export type PlaybackStatus = {
  /** Absolute ms up to which the player has every event it needs. */
  playableUntil: number;
  /** Every block from the playhead on is in the player. */
  endLoaded: boolean;
  /** Playing and about to reach a missing block: pause ("Buffering..."). */
  starving: boolean;
  /** A stalled playback may continue. */
  canResume: boolean;
};

export function playbackStatus(
  store: ReplayBlockStore,
  input: { playheadMs: number; speed: number; playing: boolean },
  config: { [K in keyof typeof PLAYBACK_DEFAULTS]: number } = PLAYBACK_DEFAULTS,
  bufferAhead: number = REPLAY_PLANNER_DEFAULTS.bufferAhead,
): PlaybackStatus {
  const playableUntil = store.playableUntil(input.playheadMs);
  const endLoaded = playableUntil === Number.POSITIVE_INFINITY;
  const speed = Math.max(1, input.speed || 1);
  const ahead = playableUntil - input.playheadMs;
  const starving =
    input.playing && !endLoaded && ahead <= config.starveMarginMs * speed;
  // Resume with enough runway, or when every block of the buffer-ahead window
  // is already here (dense blocks can fill the 30-block window in under 10 s,
  // and nothing more would be fetched until the playhead moves).
  const anchor = store.anchorIndexFor(input.playheadMs) ?? 0;
  const windowSettled = store.isSettled(anchor, anchor + bufferAhead - 1);
  const canResume =
    endLoaded ||
    ahead >= config.resumeAheadMs * speed ||
    (windowSettled && ahead > config.starveMarginMs * speed);
  return { playableUntil, endLoaded, starving, canResume };
}
