import { describe, expect, it } from 'vitest';
import {
  REPLAY_PLANNER_DEFAULTS,
  planNextBatch,
  playbackStatus,
} from './replay-block-planner';
import {
  type ReplayBlockMeta,
  ReplayBlockStore,
  computeBlockSegments,
} from './replay-block-store';

const T0 = 1_760_140_800_000;
const BLOCK_MS = 3_000;

/** n blocks of 3 s back to back (block i spans [T0+3i, T0+3i+2.5 s]). */
const blocks = (n: number, startAt = 0): ReplayBlockMeta[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `b${i + startAt}`,
    windowId: 'w',
    startMs: T0 + (i + startAt) * BLOCK_MS,
    endMs: T0 + (i + startAt) * BLOCK_MS + 2_500,
    eventsCount: 10,
    sizeBytes: 1000,
  }));

const startOf = (i: number) => T0 + i * BLOCK_MS;

/** Mark positions loaded; `fullAt` = positions holding a FullSnapshot. */
function load(
  store: ReplayBlockStore,
  positions: Iterable<number>,
  fullAt: Iterable<number> = [],
  opts: { apply?: boolean } = {},
) {
  const full = new Set(fullAt);
  for (const p of positions) {
    const e = store.entry(p)!;
    store.markLoaded(p, {
      chunks: [],
      fullSnapshots: full.has(p) ? [e.meta.startMs + 10] : [],
      minTs: e.meta.startMs,
      maxTs: e.meta.endMs,
    });
    if (opts.apply ?? true) store.takeChunks(p);
  }
}

const range = (a: number, b: number) =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('planner: initial load + buffer ahead', () => {
  it('starts with the first batch of 10 blocks', () => {
    const store = new ReplayBlockStore(blocks(200));
    expect(
      planNextBatch(store, { target: null, playbackPosition: startOf(0) }),
    ).toEqual({ positions: range(0, 9), reason: 'buffer_ahead' });
  });

  it('never re-requests blocks that are loading (idempotent loader)', () => {
    const store = new ReplayBlockStore(blocks(200));
    store.markLoading(range(0, 9));
    expect(
      planNextBatch(store, { target: null, playbackPosition: startOf(0) }),
    ).toEqual({ positions: range(10, 19), reason: 'buffer_ahead' });
    // aborted request: its blocks become requestable again
    store.markUnloaded(range(0, 9));
    expect(
      planNextBatch(store, { target: null, playbackPosition: startOf(0) })!
        .positions,
    ).toEqual(range(0, 9));
  });

  it('keeps 30 blocks buffered ahead of the playhead, then stops', () => {
    const store = new ReplayBlockStore(blocks(200));
    load(store, range(0, 49), [0, 20, 40]);
    // playhead in block 40 -> wants [40, 69]
    expect(
      planNextBatch(store, { target: null, playbackPosition: startOf(40) + 5 }),
    ).toEqual({ positions: range(50, 59), reason: 'buffer_ahead' });
    load(store, range(50, 69));
    expect(
      planNextBatch(store, { target: null, playbackPosition: startOf(40) + 5 }),
    ).toBeNull();
  });

  it('batches stay contiguous around holes', () => {
    const store = new ReplayBlockStore(blocks(50));
    load(store, [0, 3, 4], [0]);
    expect(
      planNextBatch(store, { target: null, playbackPosition: startOf(0) })!
        .positions,
    ).toEqual([1, 2]);
  });

  it('end of recording: nothing to plan once the tail is in', () => {
    const store = new ReplayBlockStore(blocks(12));
    load(store, range(0, 11), [0]);
    expect(
      planNextBatch(store, { target: null, playbackPosition: startOf(11) }),
    ).toBeNull();
    expect(
      playbackStatus(store, {
        playheadMs: startOf(11),
        speed: 1,
        playing: true,
      }).endLoaded,
    ).toBe(true);
  });

  it('a playhead with no FullSnapshot anywhere scans forward past the window', () => {
    const store = new ReplayBlockStore(blocks(100));
    load(store, range(0, 29));
    expect(
      planNextBatch(store, { target: null, playbackPosition: startOf(0) }),
    ).toEqual({ positions: range(30, 39), reason: 'seek_forward' });
  });
});

describe('planner: seek', () => {
  it('far ahead: 3 behind / 7 ahead of the target block first', () => {
    const store = new ReplayBlockStore(blocks(300));
    load(store, range(0, 29), [0]);
    const target = startOf(150) + 100;
    expect(planNextBatch(store, { target })).toEqual({
      positions: range(147, 156),
      reason: 'seek_target',
    });
    load(store, range(147, 156));
    expect(planNextBatch(store, { target })).toEqual({
      positions: [157],
      reason: 'seek_target',
    });
  });

  it('then backfills toward the nearest loaded FullSnapshot, closest first', () => {
    const store = new ReplayBlockStore(blocks(300));
    load(store, range(0, 29), [0]);
    load(store, range(100, 100), [100]);
    load(store, range(147, 157));
    const target = startOf(150) + 100;
    expect(planNextBatch(store, { target })).toEqual({
      positions: range(137, 146),
      reason: 'seek_gap_fill',
    });
    load(store, range(137, 146));
    expect(planNextBatch(store, { target })!.positions).toEqual(
      range(127, 136),
    );
  });

  it('no FullSnapshot known before the target: hunts backward, closest first', () => {
    const store = new ReplayBlockStore(blocks(300));
    load(store, range(147, 157));
    const target = startOf(150) + 100;
    expect(planNextBatch(store, { target })).toEqual({
      positions: range(137, 146),
      reason: 'seek_backward',
    });
  });

  it('a FullSnapshot inside the window makes the target playable: back to buffering ahead', () => {
    const store = new ReplayBlockStore(blocks(300));
    load(store, range(147, 157), [148]);
    const target = startOf(150) + 100;
    expect(store.canPlayAt(target)).toBe(true);
    expect(planNextBatch(store, { target, playbackPosition: target })).toEqual({
      positions: range(158, 167),
      reason: 'buffer_ahead',
    });
  });

  it('far behind the loaded region works the same way', () => {
    const store = new ReplayBlockStore(blocks(300));
    load(store, range(140, 200), [140]);
    const target = startOf(5);
    expect(planNextBatch(store, { target })).toEqual({
      positions: range(2, 11),
      reason: 'seek_target',
    });
  });

  it('nothing before the target can help: loads forward until a FullSnapshot after it', () => {
    const store = new ReplayBlockStore(blocks(40));
    load(store, range(0, 12)); // no FullSnapshot in any of them
    const target = startOf(5);
    expect(planNextBatch(store, { target })).toEqual({
      positions: range(13, 22),
      reason: 'seek_forward',
    });
    load(store, range(13, 22), [20]);
    // a FullSnapshot after the target is now known: nothing more for the seek
    expect(planNextBatch(store, { target })).toEqual({
      positions: range(23, 32),
      reason: 'buffer_ahead',
    });
  });
});

describe('store', () => {
  it('canPlayAt needs the FullSnapshot block through the target applied', () => {
    const store = new ReplayBlockStore(blocks(20));
    load(store, [4, 5, 7], [4]);
    expect(store.canPlayAt(startOf(5) + 10)).toBe(true);
    expect(store.canPlayAt(startOf(7) + 10)).toBe(false); // 6 missing
    load(store, [6], [], { apply: false });
    expect(store.canPlayAt(startOf(7) + 10)).toBe(false); // not in player yet
    expect(store.canPlayAt(startOf(7) + 10, { applied: false })).toBe(true);
    store.takeChunks(6);
    expect(store.canPlayAt(startOf(7) + 10)).toBe(true);
  });

  it('an earlier block overlapping the snapshot is required too', () => {
    const list = blocks(10);
    // block 2 is a late duplicate spanning blocks 2..6
    list[2] = { ...list[2]!, endMs: startOf(6) };
    const store = new ReplayBlockStore(list);
    load(store, [4, 5], [4]);
    expect(store.canPlayAt(startOf(5) + 10)).toBe(false);
    load(store, [2]);
    expect(store.canPlayAt(startOf(5) + 10)).toBe(true);
    // and it is where buffering ahead of such a playhead starts
    const s2 = new ReplayBlockStore(list);
    expect(s2.anchorIndexFor(startOf(5) + 10)).toBe(2);
  });

  it('setBlocks keeps loaded state by key when a live session grows', () => {
    const store = new ReplayBlockStore(blocks(5));
    load(store, [0, 1], [0]);
    store.setBlocks(blocks(8));
    expect(store.count).toBe(8);
    expect(store.entry(1)!.state).toBe('applied');
    expect(store.entry(6)!.state).toBe('unloaded');
  });

  it('a window switch is a fresh store: planning restarts at its first block', () => {
    const a = new ReplayBlockStore(blocks(50));
    load(a, range(0, 40), [0]);
    const b = new ReplayBlockStore(blocks(20, 1000));
    expect(
      planNextBatch(b, { target: null, playbackPosition: startOf(1000) })!
        .positions,
    ).toEqual(range(0, 9));
  });

  it('loadedPrefix drives the initial player events', () => {
    const store = new ReplayBlockStore(blocks(30));
    expect(store.loadedPrefix()).toBeNull();
    load(store, [0, 1, 2, 5], [1], { apply: false });
    expect(store.loadedPrefix()).toEqual({
      positions: [0, 1, 2],
      hasFullSnapshot: true,
    });
  });

  it('loadedRanges merges consecutive loaded blocks', () => {
    const store = new ReplayBlockStore(blocks(10));
    load(store, [0, 1, 2, 6]);
    expect(store.loadedRanges()).toEqual([
      { startMs: startOf(0), endMs: startOf(2) + 2_500 },
      { startMs: startOf(6), endMs: startOf(6) + 2_500 },
    ]);
  });
});

describe('playbackStatus (stall / resume)', () => {
  it('starves right before a block that is not in the player, resumes with 10 s of runway', () => {
    const store = new ReplayBlockStore(blocks(100));
    load(store, range(0, 9), [0]);
    const atEdge = startOf(10) - 200;
    expect(
      playbackStatus(store, { playheadMs: atEdge, speed: 1, playing: true }),
    ).toMatchObject({ starving: true, canResume: false, endLoaded: false });
    load(store, range(10, 13)); // 12 s of runway
    expect(
      playbackStatus(store, { playheadMs: atEdge, speed: 1, playing: true }),
    ).toMatchObject({ starving: false, canResume: true });
  });

  it('runway scales with speed', () => {
    const store = new ReplayBlockStore(blocks(100));
    load(store, range(0, 13), [0]);
    expect(
      playbackStatus(store, {
        playheadMs: startOf(10) - 200,
        speed: 4,
        playing: true,
      }).canResume,
    ).toBe(false);
  });

  it('dense blocks: resumes once the whole buffer window is in, even under 10 s', () => {
    const dense = Array.from({ length: 60 }, (_, i) => ({
      key: `d${i}`,
      windowId: 'w',
      startMs: T0 + i * 100,
      endMs: T0 + i * 100 + 50,
      eventsCount: 1,
      sizeBytes: 1,
    }));
    const store = new ReplayBlockStore(dense);
    load(store, range(0, REPLAY_PLANNER_DEFAULTS.bufferAhead + 5), [0]);
    expect(
      playbackStatus(store, { playheadMs: T0, speed: 1, playing: false })
        .canResume,
    ).toBe(true);
  });

  it('segments: idle gaps between blocks collapse, the full length is known up front', () => {
    const list = [
      ...blocks(3), // 0..8.5 s
      ...blocks(2, 30), // 90 s .. 95.5 s: 81.5 s idle gap
    ];
    expect(computeBlockSegments(list, 15_000)).toEqual([
      { startMs: startOf(0), endMs: startOf(2) + 2_500 },
      { startMs: startOf(30), endMs: startOf(31) + 2_500 },
    ]);
  });
});
