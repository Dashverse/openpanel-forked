/**
 * Block list + block data endpoints (replay-block-list.ts): pure builders,
 * and the source decision / framing / cancellation end to end with ClickHouse
 * answered by an in-memory fake and Blob by an in-memory buffer.
 */
import { zstdDecompressSync } from 'node:zlib';
import { decodeReplayFrames } from '@openpanel/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.TZ = 'UTC';
process.env.AZURE_BLOB_CONNECTION_STRING =
  'DefaultEndpointsProtocol=https;AccountName=fake;AccountKey=ZmFrZQ==;EndpointSuffix=core.windows.net';
process.env.REPLAY_SERVE_BLOCKS_PROJECT_IDS = 'p1';
process.env.REPLAY_BLOCKS_COMPLETE_SINCE = '2026-10-10T00:00:00Z';

vi.mock('@openpanel/redis', () => ({ cacheable: (fn: unknown) => fn }));
vi.mock('./chart.service', () => ({ getEventFiltersWhereClause: () => ({}) }));
vi.mock('./organization.service', () => ({
  getOrganizationByProjectIdCached: async () => null,
}));
vi.mock('./profile.service', () => ({ getProfilesCached: async () => [] }));

type Chunk = {
  project_id: string;
  session_id: string;
  window_id: string;
  chunk_index: number;
  started_ms: number;
  ended_ms: number;
  events_count: number;
  is_full_snapshot: boolean;
  payload: string;
};
const chChunks: Chunk[] = [];
const refRows: Record<string, unknown>[] = [];
const sqlLog: string[] = [];

const sessionOf = (sql: string) => /session_id = '([^']+)'/.exec(sql)?.[1];
const windowOf = (sql: string) => /window_id = '([^']*)'/.exec(sql)?.[1];

const chQuery = vi.fn(async (sql: string) => {
  sqlLog.push(sql);
  if (sql.includes('system.columns')) return [{ c: 0 }];
  if (sql.includes('FROM session_replay_blocks')) {
    return refRows.filter((r) => r.session_id === sessionOf(sql));
  }
  if (sql.includes('SELECT 1 AS older')) {
    const before = Number(
      /fromUnixTimestamp64Milli\(toInt64\((\d+)\)\)/.exec(sql)?.[1],
    );
    return chChunks.some(
      (c) => c.session_id === sessionOf(sql) && c.started_ms < before,
    )
      ? [{ older: 1 }]
      : [];
  }
  if (sql.includes('SELECT 1 AS one FROM session_replay_chunks')) {
    return chChunks.some((c) => c.session_id === sessionOf(sql))
      ? [{ one: 1 }]
      : [];
  }
  if (sql.includes('replay_archive_index')) return [];
  if (sql.includes('GROUP BY window_id, chunk_index, started_at')) {
    const seen = new Set<string>();
    return chChunks
      .filter((c) => c.session_id === sessionOf(sql))
      .filter((c) => {
        const k = `${c.window_id}|${c.chunk_index}|${c.started_ms}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort(
        (a, b) => a.started_ms - b.started_ms || a.chunk_index - b.chunk_index,
      )
      .map((c) => ({
        window_id: c.window_id,
        chunk_index: String(c.chunk_index),
        s_ms: String(c.started_ms),
        e_ms: String(c.ended_ms),
        full: c.is_full_snapshot ? '1' : '0',
        ev: String(c.events_count),
      }));
  }
  return [];
});

const chRawQuery = vi.fn(
  async (params: { query: string; abort_signal?: AbortSignal }) => {
    sqlLog.push(params.query);
    if (params.abort_signal?.aborted) {
      const e = new Error('The user aborted a request.');
      e.name = 'AbortError';
      throw e;
    }
    const tuples = new Set(
      Array.from(params.query.matchAll(/\((\d+), (\d+)\)/g)).map(
        (m) => `${m[1]}:${m[2]}`,
      ),
    );
    const rows = chChunks
      .filter(
        (c) =>
          c.session_id === sessionOf(params.query) &&
          c.window_id === windowOf(params.query) &&
          tuples.has(`${c.chunk_index}:${c.started_ms}`),
      )
      .map((c) => ({
        window_id: c.window_id,
        chunk_index: String(c.chunk_index),
        s_ms: String(c.started_ms),
        e_ms: String(c.ended_ms),
        events_count: String(c.events_count),
        full: c.is_full_snapshot ? 1 : 0,
        payload: c.payload,
      }));
    return { json: async () => rows };
  },
);

vi.mock('../clickhouse/client', () => ({
  TABLE_NAMES: {
    session_replay_chunks: 'session_replay_chunks',
    session_replay_blocks: 'session_replay_blocks',
    sessions: 'sessions',
    events: 'events',
    profiles: 'profiles',
  },
  ch: { query: (p: { query: string }) => chRawQuery(p) },
  chQuery: (sql: string) => chQuery(sql),
  formatClickhouseDate: (d: string) => d,
}));

let blob = Buffer.alloc(0);
let blobFails = false;
let blobHang = false;
let blobAbortError = false;
const blobReads: { start: number; count: number }[] = [];
vi.mock('../blob/replay-blocks', async (importOriginal) => {
  const real = await importOriginal<typeof import('../blob/replay-blocks')>();
  return {
    ...real,
    isReplayBlockStoreConfigured: () => true,
    readReplayBlockRange: (
      _p: string,
      start: number,
      count: number,
      opts?: { abortSignal?: AbortSignal },
    ) =>
      new Promise<Buffer>((resolve, reject) => {
        blobReads.push({ start, count });
        if (blobFails) return reject(new Error('blob down'));
        if (blobAbortError) {
          const e = new Error('The operation was aborted.');
          e.name = 'AbortError';
          return reject(e);
        }
        const done = () => resolve(blob.subarray(start, start + count));
        if (!blobHang) return done();
        // Hang until aborted, like a slow Azure read the client gave up on.
        opts?.abortSignal?.addEventListener('abort', () => {
          const e = new Error('The operation was aborted.');
          e.name = 'AbortError';
          reject(e);
        });
      }),
  };
});

const { compressReplayBlock } = await import('../blob/replay-blocks');
const list = await import('./replay-block-list');
const svc = await import('./session.service');

const T = Date.parse('2026-10-11T00:00:00.000Z');
const mk = (
  session: string,
  w: string,
  i: number,
  offsetMs: number,
  full = false,
  project = 'p1',
): Chunk => ({
  project_id: project,
  session_id: session,
  window_id: w,
  chunk_index: i,
  started_ms: T + offsetMs,
  ended_ms: T + offsetMs + 900,
  events_count: 2,
  is_full_snapshot: full,
  payload: JSON.stringify([
    { type: full ? 2 : 3, data: { i }, timestamp: T + offsetMs },
    { type: 3, data: { i, b: 1 }, timestamp: T + offsetMs + 100 },
  ]),
});
const toLine = (c: Chunk) =>
  JSON.stringify({
    project_id: c.project_id,
    session_id: c.session_id,
    window_id: c.window_id,
    chunk_index: c.chunk_index,
    started_at: new Date(c.started_ms).toISOString(),
    ended_at: new Date(c.ended_ms).toISOString(),
    events_count: c.events_count,
    is_full_snapshot: c.is_full_snapshot,
    payload: c.payload,
  });

function addBlock(
  chunks: Chunk[],
  blockIndex: number,
  createdIso = '2026-10-11T00:00:00Z',
) {
  const buf = compressReplayBlock(chunks.map(toLine));
  const start = blob.length;
  blob = Buffer.concat([blob, buf]);
  const c0 = chunks[0]!;
  refRows.push({
    session_id: c0.session_id,
    window_id: c0.window_id,
    block_index: String(blockIndex),
    blob_path: `blocks/x/session=${c0.session_id}.zst`,
    byte_start: String(start),
    byte_end: String(start + buf.length),
    created_ms: String(Date.parse(createdIso)),
    first_ms: String(Math.min(...chunks.map((c) => c.started_ms))),
    last_ms: String(Math.max(...chunks.map((c) => c.started_ms))),
    events_count: String(chunks.reduce((a, c) => a + c.events_count, 0)),
    size_bytes: String(buf.length),
  });
}

/** Run a prepared request, collecting the written bytes. */
async function collect(
  prepared: Awaited<ReturnType<typeof list.prepareReplayBlockData>>,
) {
  const parts: Uint8Array[] = [];
  await prepared.run((b) => {
    parts.push(Uint8Array.from(b));
  });
  return Buffer.concat(parts);
}

const linesOf = (data: Uint8Array) =>
  zstdDecompressSync(data).toString('utf8').split('\n').filter(Boolean);

beforeEach(() => {
  chChunks.length = 0;
  refRows.length = 0;
  sqlLog.length = 0;
  blob = Buffer.alloc(0);
  blobFails = false;
  blobHang = false;
  blobAbortError = false;
  blobReads.length = 0;
  list.__clearReplayBlockListCache();
});

describe('buildBlocksSourceList (pure)', () => {
  const ref = (
    blockIndex: number,
    byteStart: number,
    w: string,
    first: number,
    last: number,
  ) => ({
    windowId: w,
    blockIndex,
    blobPath: 'b',
    byteStart,
    byteEnd: byteStart + 10,
    createdAtMs: 0,
    firstStartedMs: first,
    lastStartedMs: last,
    eventsCount: 3,
    sizeBytes: 10,
    chunkKeys: [],
  });

  it('sorts by start (then window), keeps redelivered dups, collapses identical rows', () => {
    const { blocks, refsByKey } = list.buildBlocksSourceList([
      ref(30, 100, 'A', 5000, 6000), // redelivery of block 10 (same span)
      ref(10, 0, 'A', 5000, 6000),
      ref(10, 0, 'A', 5000, 6000), // same row read twice (unmerged RMT)
      ref(20, 50, 'B', 1000, 1000),
      ref(40, 200, 'A', 9000, 8000), // last < first: clamped
    ]);
    expect(blocks.map((b) => [b.index, b.key, b.windowId])).toEqual([
      [0, '20.50', 'B'],
      [1, '10.0', 'A'],
      [2, '30.100', 'A'],
      [3, '40.200', 'A'],
    ]);
    expect(blocks[3]).toMatchObject({ startMs: 9000, endMs: 9000 });
    expect(blocks[1]).toMatchObject({
      startMs: 5000,
      endMs: 6000,
      eventsCount: 3,
      sizeBytes: 10,
    });
    expect(refsByKey.size).toBe(4);
  });
});

describe('buildLegacyBlockList (pure)', () => {
  const key = (w: string, i: number, s: number, e = s + 500) => ({
    windowId: w,
    chunkIndex: i,
    startedMs: s,
    endedMs: e,
    isFullSnapshot: false,
    eventsCount: 1,
  });

  it('pages each window in order and sorts pages by start', () => {
    const { blocks, pages } = list.buildLegacyBlockList(
      [
        key('A', 0, 0),
        key('B', 0, 50),
        key('A', 1, 100),
        key('A', 0, 200), // recorder restart: new chunk with chunk_index 0
        key('A', 2, 300, 900),
      ],
      2,
    );
    expect(blocks.map((b) => [b.index, b.windowId, b.key])).toEqual([
      [0, 'A', 'c0.0'],
      [1, 'B', 'c50.0'],
      [2, 'A', 'c200.0'],
    ]);
    expect(blocks[0]).toMatchObject({ startMs: 0, endMs: 600, eventsCount: 2 });
    expect(blocks[2]).toMatchObject({
      startMs: 200,
      endMs: 900,
      eventsCount: 2,
    });
    expect(
      pages
        .get('A\u0000c200.0')!
        .chunks.map((c) => [c.chunkIndex, c.startedMs]),
    ).toEqual([
      [0, 200],
      [2, 300],
    ]);
  });

  it('windows: idle gaps collapsed exactly like replayActiveMs', () => {
    const windows = list.computeBlockListWindows(
      [
        { windowId: 'A', startMs: 0, endMs: 1000, eventsCount: 1 },
        { windowId: 'A', startMs: 2000, endMs: 3000, eventsCount: 1 },
        // 60 s idle gap (>= 15 s) is not counted as active
        { windowId: 'A', startMs: 63_000, endMs: 64_000, eventsCount: 1 },
        { windowId: 'B', startMs: 500, endMs: 700, eventsCount: 4 },
      ],
      15_000,
    );
    expect(windows).toEqual([
      {
        windowId: 'A',
        startMs: 0,
        endMs: 64_000,
        durationMs: 64_000,
        activeMs: 4000,
        blockCount: 3,
        eventsCount: 3,
      },
      {
        windowId: 'B',
        startMs: 500,
        endMs: 700,
        durationMs: 200,
        activeMs: 200,
        blockCount: 1,
        eventsCount: 4,
      },
    ]);
  });
});

describe('getReplayBlockList', () => {
  it('blocks source: list from refs only, no Blob reads, dups kept', async () => {
    const cs = [mk('s', 'w', 0, 0, true), mk('s', 'w', 1, 1000)];
    addBlock(cs, 100);
    addBlock(cs, 100); // redelivered batch appended again (new byte range)
    addBlock([mk('s', 'w', 2, 5000)], 101);
    const res = await list.getReplayBlockList('s', 'p1');
    expect(res.source).toBe('blocks');
    expect(res.blocks).toHaveLength(3);
    expect(res.blocks.map((b) => b.startMs)).toEqual([T, T, T + 5000]);
    expect(res.windows).toHaveLength(1);
    expect(res.windows[0]).toMatchObject({
      windowId: 'w',
      startMs: T,
      endMs: T + 5000,
      blockCount: 3,
    });
    expect(blobReads).toHaveLength(0);
    // ref read + completeness guard; never the chunk table's payloads
    expect(sqlLog.some((s) => s.includes('payload'))).toBe(false);
  });

  it('resumed session (legacy holds older chunks) goes legacy', async () => {
    const old = mk('r', 'w', 0, -60_000, true);
    const later = [mk('r', 'w', 1, 0), mk('r', 'w', 2, 1000)];
    chChunks.push(old, ...later);
    addBlock(later, 200);
    const res = await list.getReplayBlockList('r', 'p1');
    expect(res.source).toBe('ch');
    expect(res.blocks.map((b) => b.key)).toEqual([
      `c${T - 60_000}.0`,
      `c${T + 1000}.2`,
    ]);
    expect(res.windows[0]!.blockCount).toBe(2);
  });

  it('not allow-listed project goes legacy without looking at refs', async () => {
    chChunks.push(mk('n', 'w', 0, 0, true, 'p2'));
    const res = await list.getReplayBlockList('n', 'p2');
    expect(res.source).toBe('ch');
    expect(sqlLog.some((s) => s.includes('session_replay_blocks'))).toBe(false);
  });

  it('caches briefly (one resolution for list + data)', async () => {
    addBlock([mk('c', 'w', 0, 0, true)], 1);
    await list.getReplayBlockList('c', 'p1');
    const n = sqlLog.length;
    await list.getReplayBlockList('c', 'p1');
    expect(sqlLog.length).toBe(n);
  });
});

describe('prepareReplayBlockData', () => {
  it('blocks source: raw stored bytes, framed, decodable to the original lines', async () => {
    const a = [mk('s', 'w', 0, 0, true), mk('s', 'w', 1, 1000)];
    const b = [mk('s', 'w', 2, 5000)];
    addBlock(a, 100);
    addBlock(b, 101);
    const { blocks } = await list.getReplayBlockList('s', 'p1');
    const prepared = await list.prepareReplayBlockData({
      sessionId: 's',
      projectId: 'p1',
      windowId: 'w',
      source: 'blocks',
      keys: blocks.map((x) => x.key),
    });
    const frames = decodeReplayFrames(await collect(prepared));
    expect(frames.map((f) => f.key).sort()).toEqual(
      blocks.map((x) => x.key).sort(),
    );
    const byKey = new Map(frames.map((f) => [f.key, f.data]));
    expect(linesOf(byKey.get(blocks[0]!.key)!)).toEqual(a.map(toLine));
    expect(linesOf(byKey.get(blocks[1]!.key)!)).toEqual(b.map(toLine));
    // adjacent ranges coalesced into one GET
    expect(blobReads).toHaveLength(1);
  });

  it('legacy source: chunks re-serialized to block lines, one decode path', async () => {
    const cs = [
      mk('l', 'w', 0, 0, true),
      mk('l', 'w', 1, 1000),
      mk('l', 'w', 2, 2000),
    ];
    chChunks.push(...cs);
    const { blocks, source } = await list.getReplayBlockList('l', 'p1');
    expect(source).toBe('ch');
    const prepared = await list.prepareReplayBlockData({
      sessionId: 'l',
      projectId: 'p1',
      windowId: 'w',
      source: 'ch',
      keys: blocks.map((x) => x.key),
    });
    const frames = decodeReplayFrames(await collect(prepared));
    expect(frames.map((f) => f.key)).toEqual(blocks.map((x) => x.key));
    const lines = frames.flatMap((f) => linesOf(f.data));
    expect(lines).toEqual(cs.map(toLine));
  });

  it('rejects more than 100 blocks, unknown keys and a changed source', async () => {
    addBlock([mk('s', 'w', 0, 0, true)], 1);
    const { blocks } = await list.getReplayBlockList('s', 'p1');
    const base = { sessionId: 's', projectId: 'p1', windowId: 'w' };
    await expect(
      list.prepareReplayBlockData({
        ...base,
        source: 'blocks',
        keys: Array.from({ length: 101 }, (_, i) => `${i}.0`),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      list.prepareReplayBlockData({ ...base, source: 'blocks', keys: ['9.9'] }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      list.prepareReplayBlockData({
        ...base,
        source: 'ch',
        keys: [blocks[0]!.key],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      list.prepareReplayBlockData({
        ...base,
        windowId: 'other',
        source: 'blocks',
        keys: [blocks[0]!.key],
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('client cancel aborts the Blob read and never falls back to ClickHouse', async () => {
    addBlock([mk('s', 'w', 0, 0, true)], 1);
    const { blocks } = await list.getReplayBlockList('s', 'p1');
    blobHang = true;
    const abort = new AbortController();
    const prepared = await list.prepareReplayBlockData({
      sessionId: 's',
      projectId: 'p1',
      windowId: 'w',
      source: 'blocks',
      keys: [blocks[0]!.key],
      signal: abort.signal,
    });
    sqlLog.length = 0;
    const run = collect(prepared);
    await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(sqlLog).toEqual([]);
  });

  it('a genuine Blob failure fails the request (no silent store switch)', async () => {
    addBlock([mk('s', 'w', 0, 0, true)], 1);
    const { blocks } = await list.getReplayBlockList('s', 'p1');
    blobFails = true;
    const prepared = await list.prepareReplayBlockData({
      sessionId: 's',
      projectId: 'p1',
      windowId: 'w',
      source: 'blocks',
      keys: [blocks[0]!.key],
    });
    sqlLog.length = 0;
    await expect(collect(prepared)).rejects.toThrow('blob down');
    expect(sqlLog).toEqual([]);
  });
});

describe('existing chunk readers: abort does not fall back', () => {
  it('replayChunksFrom: a cancelled blocks read rejects, no legacy query', async () => {
    const cs = [mk('a', 'w', 0, 0, true), mk('a', 'w', 1, 1000)];
    chChunks.push(...cs); // legacy copy exists (dual write)...
    // ...but blocks are complete and preferred: the guard only fails on
    // OLDER legacy chunks, these are equal.
    addBlock(cs, 1);
    // Build the per-chunk index first (decodes the blocks once).
    await svc.getSessionReplayMeta('a', 'p1');
    blobHang = true;
    const abort = new AbortController();
    sqlLog.length = 0;
    const p = svc.getSessionReplayChunksFrom('a', 'p1', 0, 'w', {
      signal: abort.signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      sqlLog.filter(
        (s) => s.includes('session_replay_chunks') && s.includes('payload'),
      ),
    ).toEqual([]);
    expect(sqlLog.some((s) => s.includes('row_number()'))).toBe(false);
  });

  it('an AbortError from Azure without a caller signal still never falls back', async () => {
    const cs = [mk('b', 'w', 0, 0, true)];
    chChunks.push(...cs);
    addBlock(cs, 1);
    await svc.getSessionReplayMeta('b', 'p1');
    blobAbortError = true;
    sqlLog.length = 0;
    await expect(
      svc.getSessionReplayChunksByIndexRange('b', 'p1', 0, 0, 'w'),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(sqlLog.some((s) => s.includes('row_number()'))).toBe(false);
  });

  it('a genuine Blob error in the old readers still serves legacy (unchanged)', async () => {
    const cs = [mk('g', 'w', 0, 0, true)];
    chChunks.push(...cs);
    addBlock(cs, 1);
    await svc.getSessionReplayMeta('g', 'p1');
    blobFails = true;
    sqlLog.length = 0;
    await svc
      .getSessionReplayChunksByIndexRange('g', 'p1', 0, 0, 'w')
      .catch(() => null);
    expect(sqlLog.some((s) => s.includes('row_number()'))).toBe(true);
  });
});
