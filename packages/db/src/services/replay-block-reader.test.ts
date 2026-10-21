import { describe, expect, it, vi } from 'vitest';

vi.mock('../clickhouse/client', () => ({
  TABLE_NAMES: { session_replay_blocks: 'session_replay_blocks' },
  chQuery: vi.fn(async () => []),
}));

const { compressReplayBlock } = await import('../blob/replay-blocks');
const { parseReplayTimestampMs, replayChunkKeyOf } = await import(
  './replay-block.service'
);
const reader = await import('./replay-block-reader');
const {
  __setReplayRangeReaderForTests,
  buildReplayIndex,
  chooseReplayRefs,
  computeReplayMeta,
  computeReplaySegments,
  computeReplayWindows,
  loadReplayChunksFromBlocks,
  parseReplayLineHead,
  planReplayRangeGets,
  replayAnchorSeq,
  resolveReplayRefKeys,
  scopeReplayKeys,
} = reader;
type ReplayBlockRef = import('./replay-block-reader').ReplayBlockRef;

const IDLE = 15_000;
const iso = (ms: number) => new Date(ms).toISOString();

interface FixtureChunk {
  w: string;
  i: number;
  s: number;
  e: number;
  full?: boolean;
}
const line = (c: FixtureChunk) =>
  JSON.stringify({
    project_id: 'p',
    session_id: 'S',
    window_id: c.w,
    chunk_index: c.i,
    started_at: iso(c.s),
    ended_at: iso(c.e),
    events_count: 1,
    is_full_snapshot: c.full ?? false,
    payload: JSON.stringify([
      { type: 3, data: { w: c.w, i: c.i, s: c.s }, timestamp: c.s },
    ]),
  });

// Base = 2026-10-10T00:00:00Z so ISO strings are realistic.
const T0 = Date.parse('2026-10-10T00:00:00Z');
const A0 = { w: 'A', i: 0, s: T0 + 1000, e: T0 + 1900, full: true };
const A1 = { w: 'A', i: 1, s: T0 + 2000, e: T0 + 2900 };
const A2 = { w: 'A', i: 2, s: T0 + 3000, e: T0 + 3900 };
// recorder restart in the same window: chunk_index starts again at 0
const A0b = { w: 'A', i: 0, s: T0 + 40_000, e: T0 + 40_900, full: true };
const A1b = { w: 'A', i: 1, s: T0 + 41_000, e: T0 + 41_900 };
const B0 = { w: 'B', i: 0, s: T0 + 2500, e: T0 + 3400, full: true };
// collides with A1b on (chunk_index, started_at) in SESSION scope only
const B1 = { w: 'B', i: 1, s: T0 + 41_000, e: T0 + 41_500 };

/** Blocks as appended to one append blob (window per block, like the writer). */
const BLOCKS: { blockIndex: number; w: string; chunks: FixtureChunk[] }[] = [
  { blockIndex: 10, w: 'A', chunks: [A0, A1] },
  { blockIndex: 12, w: 'B', chunks: [B0] },
  { blockIndex: 13, w: 'A', chunks: [A1, A2] }, // A1 = exact SDK retry
  { blockIndex: 20, w: 'A', chunks: [A0b, A1b] },
  { blockIndex: 21, w: 'B', chunks: [B1] },
  { blockIndex: 30, w: 'A', chunks: [A1, A2] }, // redelivered batch re-appended
];

function buildBlob(withKeys: boolean) {
  const parts: Buffer[] = [];
  const refs: ReplayBlockRef[] = [];
  let offset = 0;
  for (const b of BLOCKS) {
    const lines = b.chunks.map(line);
    const buf = compressReplayBlock(lines);
    refs.push({
      windowId: b.w,
      blockIndex: b.blockIndex,
      blobPath: 'blocks/dt=2026-10-10/project=p/session=S.zst',
      byteStart: offset,
      byteEnd: offset + buf.length,
      createdAtMs: T0,
      firstStartedMs: Math.min(...b.chunks.map((c) => c.s)),
      lastStartedMs: Math.max(...b.chunks.map((c) => c.s)),
      eventsCount: b.chunks.length,
      sizeBytes: buf.length,
      chunkKeys: withKeys
        ? b.chunks.map((c) => replayChunkKeyOf(JSON.parse(line(c)))!)
        : [],
    });
    parts.push(buf);
    offset += buf.length;
  }
  return { blob: Buffer.concat(parts), refs };
}

function installBlob(blob: Buffer) {
  const gets: { start: number; count: number }[] = [];
  __setReplayRangeReaderForTests(async (_path, start, count) => {
    gets.push({ start, count });
    return blob.subarray(start, start + count);
  });
  return gets;
}

/**
 * Reference: the SQL contract (replayChunkKeysSql) evaluated over the RAW rows
 * of a store - every line of every block, duplicates included.
 */
function sqlContractKeys(rows: FixtureChunk[], windowId?: string) {
  const g = new Map<string, { i: number; s: number; full: boolean }>();
  for (const r of rows) {
    if (windowId !== undefined && r.w !== windowId) continue;
    const k = `${r.i}:${r.s}`;
    const cur = g.get(k);
    g.set(k, { i: r.i, s: r.s, full: Boolean(cur?.full || r.full) });
  }
  return Array.from(g.values())
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((k, seq) => ({
      seq,
      chunkIndex: k.i,
      startedMs: k.s,
      isFullSnapshot: k.full,
    }));
}
const RAW_ROWS = BLOCKS.flatMap((b) => b.chunks);

describe('parseReplayTimestampMs', () => {
  it('matches DateTime64(3) best_effort parsing (UTC, truncated to ms)', () => {
    expect(parseReplayTimestampMs('2026-10-09T13:09:21.968Z')).toBe(
      Date.UTC(2026, 9, 9, 13, 9, 21, 968),
    );
    expect(parseReplayTimestampMs('2026-10-09 13:09:21.968')).toBe(
      Date.UTC(2026, 9, 9, 13, 9, 21, 968),
    );
    expect(parseReplayTimestampMs('2026-10-09 13:09:21')).toBe(
      Date.UTC(2026, 9, 9, 13, 9, 21, 0),
    );
    expect(parseReplayTimestampMs('2026-10-09T13:09:21.9687Z')).toBe(
      Date.UTC(2026, 9, 9, 13, 9, 21, 968),
    );
    expect(parseReplayTimestampMs('2026-10-09T18:39:21.5+05:30')).toBe(
      Date.UTC(2026, 9, 9, 13, 9, 21, 500),
    );
    expect(Number.isNaN(parseReplayTimestampMs('nope'))).toBe(true);
  });
});

describe('parseReplayLineHead', () => {
  it('reads key fields without the payload, even if the payload mentions payload', () => {
    const l = JSON.stringify({
      project_id: 'p',
      session_id: 'S',
      window_id: 'w',
      chunk_index: 7,
      started_at: '2026-10-10T00:00:01.000Z',
      ended_at: '2026-10-10T00:00:02.000Z',
      events_count: 1,
      is_full_snapshot: true,
      payload: '[{"x":",\\"payload\\":1"}]',
    });
    const head = parseReplayLineHead(l)!;
    expect(head.chunk_index).toBe(7);
    expect(head.window_id).toBe('w');
    expect(head.is_full_snapshot).toBe(true);
  });
  it('falls back to a full parse when payload is not last', () => {
    const l = JSON.stringify({
      payload: '[]',
      chunk_index: 3,
      started_at: '2026-10-10T00:00:01.000Z',
      window_id: 'w',
    });
    expect(parseReplayLineHead(l)!.chunk_index).toBe(3);
  });
});

describe('block key index - parity with the SQL chunk contract', () => {
  it('chunk_keys and the empty-chunk_keys decode fallback build the same index', async () => {
    const withKeys = buildBlob(true);
    const noKeys = buildBlob(false);
    const gets = installBlob(noKeys.blob);
    const a = buildReplayIndex(await resolveReplayRefKeys(withKeys.refs));
    const b = buildReplayIndex(await resolveReplayRefKeys(noKeys.refs));
    const strip = (rows: typeof a) =>
      rows.map((r) => ({ ...r, refs: r.refs.map((x) => x.blockIndex) }));
    expect(strip(b)).toEqual(strip(a));
    // decode path fetched the key-less refs (coalesced into one GET here)
    expect(gets.length).toBe(1);
    // second resolve of the same immutable blocks is served from cache
    await resolveReplayRefKeys(noKeys.refs);
    expect(gets.length).toBe(1);
  });

  it('window scope: restarts kept, exact retries + duplicate blocks collapsed', async () => {
    const { refs } = buildBlob(true);
    const index = buildReplayIndex(await resolveReplayRefKeys(refs));
    const keys = scopeReplayKeys(index, 'A').map(
      ({ seq, chunkIndex, startedMs, isFullSnapshot }) => ({
        seq,
        chunkIndex,
        startedMs,
        isFullSnapshot,
      }),
    );
    expect(keys).toEqual(sqlContractKeys(RAW_ROWS, 'A'));
    expect(keys.map((k) => [k.seq, k.chunkIndex])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 0],
      [4, 1],
    ]);
  });

  it('session scope groups by (chunk_index, started_at) across windows like the SQL', async () => {
    const { refs } = buildBlob(true);
    const index = buildReplayIndex(await resolveReplayRefKeys(refs));
    const keys = scopeReplayKeys(index).map(
      ({ seq, chunkIndex, startedMs, isFullSnapshot }) => ({
        seq,
        chunkIndex,
        startedMs,
        isFullSnapshot,
      }),
    );
    expect(keys).toEqual(sqlContractKeys(RAW_ROWS));
    expect(keys).toHaveLength(6); // A1b and B1 share (1, 41000)
  });

  it('is_full_snapshot is the max over duplicates', () => {
    const ref = { blockIndex: 1 } as ReplayBlockRef;
    const ref2 = { blockIndex: 2 } as ReplayBlockRef;
    const k = { windowId: 'A', chunkIndex: 0, startedMs: 5, endedMs: 6 };
    const index = buildReplayIndex([
      { ref, key: { ...k, isFullSnapshot: false } },
      { ref: ref2, key: { ...k, isFullSnapshot: true } },
    ]);
    expect(index).toHaveLength(1);
    expect(index[0]!.isFullSnapshot).toBe(true);
    expect(index[0]!.refs).toHaveLength(2);
  });

  it('anchor = last full snapshot at/before the target (seq), else 0', async () => {
    const { refs } = buildBlob(true);
    const keys = scopeReplayKeys(
      buildReplayIndex(await resolveReplayRefKeys(refs)),
      'A',
    );
    expect(replayAnchorSeq(keys, T0 + 500)).toBe(0);
    expect(replayAnchorSeq(keys, T0 + 3500)).toBe(0);
    expect(replayAnchorSeq(keys, T0 + 40_500)).toBe(3);
  });

  it('windows / segments / meta match the SQL aggregates', async () => {
    const { refs } = buildBlob(true);
    const index = buildReplayIndex(await resolveReplayRefKeys(refs));
    expect(computeReplayWindows(index, IDLE)).toEqual([
      {
        windowId: 'A',
        chunkCount: 5,
        fullSnapshotCount: 2,
        startedAtMs: T0 + 1000,
        endedAtMs: T0 + 41_900,
        // span 40 900 − idle gap (40 000 − 3 900)
        activeMs: 40_900 - 36_100,
      },
      {
        windowId: 'B',
        chunkCount: 2,
        fullSnapshotCount: 1,
        startedAtMs: T0 + 2500,
        endedAtMs: T0 + 41_500,
        activeMs: 39_000 - 37_600,
      },
    ]);
    expect(computeReplaySegments(index, IDLE, 'A')).toEqual([
      { startMs: T0 + 1000, endMs: T0 + 3900 },
      { startMs: T0 + 40_000, endMs: T0 + 41_900 },
    ]);
    expect(computeReplaySegments(index, IDLE)).toEqual([
      { startMs: T0 + 1000, endMs: T0 + 3900 },
      { startMs: T0 + 40_000, endMs: T0 + 41_900 },
    ]);
    expect(computeReplayMeta(index)).toEqual({
      startedAtMs: T0 + 1000,
      endedAtMs: T0 + 41_900,
      chunkCount: 7, // distinct (window, chunk_index, started_at)
    });
  });
});

describe('page loading', () => {
  it('picks the fewest blocks (never the redelivered copy) and returns seq-indexed chunks', async () => {
    const { blob, refs } = buildBlob(true);
    const keys = scopeReplayKeys(
      buildReplayIndex(await resolveReplayRefKeys(refs)),
      'A',
    );
    expect(
      chooseReplayRefs(keys)
        .map((r) => r.blockIndex)
        .sort((a, b) => a - b),
    ).toEqual([10, 13, 20]);

    installBlob(blob);
    const page = await loadReplayChunksFromBlocks(keys.slice(1, 4), 'A');
    expect(Array.from(page.keys()).sort()).toEqual([1, 2, 3]);
    const c3 = page.get(3)!;
    expect(c3.startedMs).toBe(A0b.s);
    expect(c3.endedMs).toBe(A0b.e);
    expect(JSON.parse(c3.payload)[0].data).toEqual({ w: 'A', i: 0, s: A0b.s });
  });

  it('window scope never serves another window’s chunk with the same key', async () => {
    const { blob, refs } = buildBlob(true);
    const keys = scopeReplayKeys(
      buildReplayIndex(await resolveReplayRefKeys(refs)),
      'B',
    );
    installBlob(blob);
    const page = await loadReplayChunksFromBlocks(keys, 'B');
    expect(JSON.parse(page.get(1)!.payload)[0].data.w).toBe('B');
  });

  it('coalesces adjacent ranges per blob, respecting gap and size caps', () => {
    const r = (blobPath: string, byteStart: number, byteEnd: number) =>
      ({
        blobPath,
        byteStart,
        byteEnd,
        blockIndex: byteStart,
      }) as ReplayBlockRef;
    const refs = [
      r('x', 0, 10),
      r('x', 10, 20),
      r('x', 50, 60),
      r('y', 0, 5),
      r('x', 10, 20),
    ];
    expect(
      planReplayRangeGets(refs, 0, 1000).map((g) => [
        g.blobPath,
        g.start,
        g.end,
        g.refs.length,
      ]),
    ).toEqual([
      ['x', 0, 20, 2],
      ['x', 50, 60, 1],
      ['y', 0, 5, 1],
    ]);
    expect(
      planReplayRangeGets(refs, 30, 1000).map((g) => [
        g.blobPath,
        g.start,
        g.end,
      ]),
    ).toEqual([
      ['x', 0, 60],
      ['y', 0, 5],
    ]);
    expect(
      planReplayRangeGets(refs, 30, 15).map((g) => [g.start, g.end]),
    ).toEqual([
      [0, 10],
      [10, 20],
      [50, 60],
      [0, 5],
    ]);
  });
});
