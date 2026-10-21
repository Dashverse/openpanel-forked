/**
 * Source resolution matrix for replay serving (REPLAY_SERVE_BLOCKS_PROJECT_IDS)
 * and the blocks readers, end to end through session.service with
 * ClickHouse answered by an in-memory fake and Blob by an in-memory buffer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The CH path parses CH's zone-less DateTime64 strings with `new Date()` (local
// time); prod pods run UTC, so pin it here to compare like for like.
process.env.TZ = 'UTC';
process.env.AZURE_BLOB_CONNECTION_STRING =
  'DefaultEndpointsProtocol=https;AccountName=fake;AccountKey=ZmFrZQ==;EndpointSuffix=core.windows.net';
process.env.REPLAY_SERVE_BLOCKS_PROJECT_IDS = 'p1,pfail';
process.env.REPLAY_BLOCKS_COMPLETE_SINCE = '2026-10-10T00:00:00Z';

vi.mock('@openpanel/redis', () => ({ cacheable: (fn: unknown) => fn }));
vi.mock('./chart.service', () => ({ getEventFiltersWhereClause: () => ({}) }));
vi.mock('./organization.service', () => ({
  getOrganizationByProjectIdCached: async () => null,
}));
vi.mock('./profile.service', () => ({ getProfilesCached: async () => [] }));

// --- fake stores -------------------------------------------------------------
type Chunk = {
  project_id: string;
  session_id: string;
  window_id: string;
  chunk_index: number;
  started_at: string;
  ended_at: string;
  events_count: number;
  is_full_snapshot: boolean;
  payload: string;
};
const chChunks: Chunk[] = [];
const refRows: Record<string, unknown>[] = [];
const sqlLog: string[] = [];
let failRefsFor: string | null = null;
let failGuard = false;
// replay_archive_index rows (only first_started_at matters for the guard)
const archiveRows: {
  project_id: string;
  session_id: string;
  first_ms: number;
}[] = [];
const chunkKeysColumn = true;

const ms = (s: string) => Date.parse(`${s.replace(' ', 'T')}Z`);
const chTime = (t: number) =>
  new Date(t).toISOString().replace('T', ' ').replace('Z', '');

function scopeOf(sql: string) {
  const sid = /session_id = '([^']+)'/.exec(sql)?.[1];
  const pid = /project_id = '([^']+)'/.exec(sql)?.[1];
  const win = /window_id = '([^']*)'/.exec(sql)?.[1];
  return chChunks.filter(
    (c) =>
      c.session_id === sid &&
      c.project_id === pid &&
      (win === undefined || c.window_id === win),
  );
}

const chQuery = vi.fn(async (sql: string) => {
  sqlLog.push(sql);
  if (sql.includes('system.columns')) return [{ c: chunkKeysColumn ? 1 : 0 }];
  if (
    sql.includes('FROM session_replay_blocks') &&
    sql.includes('ORDER BY block_index')
  ) {
    const sid = /session_id = '([^']+)'/.exec(sql)?.[1];
    if (failRefsFor && sid === failRefsFor) throw new Error('boom');
    return refRows.filter((r) => r.session_id === sid);
  }
  if (sql.includes('SELECT 1 AS older')) {
    // completeness guard (b)
    if (failGuard) throw new Error('guard down');
    const sid = /session_id = '([^']+)'/.exec(sql)?.[1];
    const pid = /project_id = '([^']+)'/.exec(sql)?.[1];
    const before = Number(
      /fromUnixTimestamp64Milli\(toInt64\((\d+)\)\)/.exec(sql)?.[1],
    );
    const chOlder = chChunks.some(
      (c) =>
        c.project_id === pid &&
        c.session_id === sid &&
        ms(c.started_at) < before,
    );
    const archOlder =
      sql.includes('replay_archive_index') &&
      archiveRows.some(
        (r) =>
          r.project_id === pid && r.session_id === sid && r.first_ms < before,
      );
    return chOlder || archOlder ? [{ older: 1 }] : [];
  }
  if (sql.includes('any(events_count) AS ev')) {
    // completeness guard (c): one row per distinct CH chunk
    if (failGuard) throw new Error('guard down');
    const seen = new Map<string, Chunk>();
    for (const c of scopeOf(sql)) {
      seen.set(`${c.window_id}:${c.chunk_index}:${c.started_at}`, c);
    }
    return [...seen.values()].map((c) => ({
      window_id: c.window_id,
      chunk_index: c.chunk_index,
      ms: String(ms(c.started_at)),
      ev: c.events_count,
    }));
  }
  if (sql.includes('SELECT 1 AS one FROM session_replay_chunks')) {
    return scopeOf(sql).length ? [{ one: 1 }] : [];
  }
  if (sql.includes('replay_archive_index')) return [];
  if (sql.includes('row_number() OVER (ORDER BY started_at, chunk_index)')) {
    // replayChunkKeysSql + the getSessionReplayChunksFrom seq window
    const g = new Map<string, { i: number; s: number; full: boolean }>();
    for (const c of scopeOf(sql)) {
      const k = `${c.chunk_index}:${c.started_at}`;
      g.set(k, {
        i: c.chunk_index,
        s: ms(c.started_at),
        full: Boolean(g.get(k)?.full || c.is_full_snapshot),
      });
    }
    const lo = Number(/seq >= (\d+)/.exec(sql)?.[1] ?? 0);
    const hi = Number(/seq < (\d+)/.exec(sql)?.[1] ?? Number.MAX_SAFE_INTEGER);
    return Array.from(g.values())
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .map((k, seq) => ({ seq, chunk_index: k.i, started_ms: String(k.s) }))
      .filter((k) => k.seq >= lo && k.seq < hi);
  }
  if (sql.includes('AS start_ms') && sql.includes('AS end_ms')) {
    // getSessionWindowSegments (legacy)
    return scopeOf(sql)
      .sort((a, b) => ms(a.started_at) - ms(b.started_at))
      .map((c) => ({
        start_ms: String(ms(c.started_at)),
        end_ms: String(ms(c.ended_at)),
      }));
  }
  if (sql.includes('LIMIT 1 BY chunk_index, started_at')) {
    // legacy payload page
    const tuples = new Set(
      Array.from(sql.matchAll(/\((\d+), (\d+)\)/g)).map(
        (m) => `${m[1]}:${m[2]}`,
      ),
    );
    const seen = new Set<string>();
    return scopeOf(sql)
      .filter((c) => tuples.has(`${c.chunk_index}:${ms(c.started_at)}`))
      .filter((c) => {
        const k = `${c.chunk_index}:${c.started_at}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((c) => ({
        chunk_index: c.chunk_index,
        payload: c.payload,
        chunk_started_at: c.started_at,
        chunk_ended_at: c.ended_at,
        started_ms: String(ms(c.started_at)),
      }));
  }
  if (sql.includes('uniqExact(window_id, chunk_index, started_at)')) {
    const rows = scopeOf(sql);
    if (!rows.length) return [];
    return [
      {
        started_at_ms: String(Math.min(...rows.map((r) => ms(r.started_at)))),
        ended_at_ms: String(Math.max(...rows.map((r) => ms(r.ended_at)))),
        chunk_count: String(
          new Set(
            rows.map((r) => `${r.window_id}|${r.chunk_index}|${r.started_at}`),
          ).size,
        ),
      },
    ];
  }
  return [];
});

vi.mock('../clickhouse/client', () => ({
  TABLE_NAMES: {
    session_replay_chunks: 'session_replay_chunks',
    session_replay_blocks: 'session_replay_blocks',
    sessions: 'sessions',
    events: 'events',
    profiles: 'profiles',
  },
  ch: {},
  chQuery: (sql: string) => chQuery(sql),
  formatClickhouseDate: (d: string) => d,
}));

let blob = Buffer.alloc(0);
let blobFails = false;
vi.mock('../blob/replay-blocks', async (importOriginal) => {
  const real = await importOriginal<typeof import('../blob/replay-blocks')>();
  return {
    ...real,
    isReplayBlockStoreConfigured: () => true,
    readReplayBlockRange: async (_p: string, start: number, count: number) => {
      if (blobFails) throw new Error('blob down');
      return blob.subarray(start, start + count);
    },
  };
});

const { compressReplayBlock } = await import('../blob/replay-blocks');
const { replayChunkKeyOf } = await import('./replay-block.service');
const svc = await import('./session.service');

const mkChunk = (
  project: string,
  session: string,
  w: string,
  i: number,
  startIso: string,
  full = false,
): Chunk => {
  const s = Date.parse(startIso);
  return {
    project_id: project,
    session_id: session,
    window_id: w,
    chunk_index: i,
    started_at: chTime(s),
    ended_at: chTime(s + 500),
    events_count: 1,
    is_full_snapshot: full,
    payload: JSON.stringify([{ type: 3, data: { i, s }, timestamp: s }]),
  };
};
// The block line is the API's JSON (ISO timestamps); CH stores the same row.
const toLine = (c: Chunk) =>
  JSON.stringify({
    ...c,
    started_at: `${c.started_at.replace(' ', 'T')}Z`,
    ended_at: `${c.ended_at.replace(' ', 'T')}Z`,
  });

function addBlock(chunks: Chunk[], blockIndex: number, createdIso: string) {
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
    first_ms: String(Math.min(...chunks.map((c) => ms(c.started_at)))),
    // As the writer does: a block's events_count is its chunks' sum.
    events_count: String(chunks.reduce((n, c) => n + c.events_count, 0)),
    chunk_keys: chunks.map((c) => replayChunkKeyOf(JSON.parse(toLine(c)))),
  });
}

beforeEach(() => {
  chChunks.length = 0;
  refRows.length = 0;
  sqlLog.length = 0;
  blob = Buffer.alloc(0);
  blobFails = false;
  failRefsFor = null;
  failGuard = false;
  archiveRows.length = 0;
});

const stripItems = (
  items: {
    chunkIndex: number;
    startedAtMs: number;
    endedAtMs: number;
    events: unknown[];
  }[],
) =>
  items.map((i) => [
    i.chunkIndex,
    i.startedAtMs,
    i.endedAtMs,
    JSON.stringify(i.events),
  ]);

describe('replay source resolution', () => {
  it('project not allow-listed → legacy (no refs lookup)', async () => {
    chChunks.push(mkChunk('p2', 's', 'w', 0, '2026-10-11T00:00:00.000Z', true));
    const meta = await svc.getSessionReplayMeta('s', 'p2');
    expect(meta.source).toBe('ch');
    expect(sqlLog.some((s) => s.includes('session_replay_blocks'))).toBe(false);
  });

  it('allow-listed, no refs → legacy unchanged', async () => {
    chChunks.push(mkChunk('p1', 's', 'w', 0, '2026-10-11T00:00:00.000Z', true));
    const meta = await svc.getSessionReplayMeta('s', 'p1');
    expect(meta.source).toBe('ch');
    expect(meta.totalChunkCount).toBe(1);
  });

  it('refs all after COMPLETE_SINCE → blocks only (identical items to CH)', async () => {
    const cs = [
      mkChunk('p1', 's', 'w', 0, '2026-10-11T00:00:00.000Z', true),
      mkChunk('p1', 's', 'w', 1, '2026-10-11T00:00:01.000Z'),
      mkChunk('p1', 's', 'w', 0, '2026-10-11T00:00:05.000Z', true), // restart
    ];
    chChunks.push(...cs);
    // Reference = the CH answer, computed before any refs exist.
    const chPage = await svc.getSessionReplayChunksFrom('s', 'p1', 0, 'w');
    const chMeta = await svc.getSessionReplayMeta('s', 'p1');
    expect(chMeta.source).toBe('ch');

    addBlock(cs.slice(0, 2), 100, '2026-10-11T00:00:02Z');
    addBlock(cs.slice(1, 3), 101, '2026-10-11T00:00:06Z'); // retry dup of chunk 1
    sqlLog.length = 0;
    const meta = await svc.getSessionReplayMeta('s', 'p1');
    expect(meta.source).toBe('blocks');
    expect(meta.totalChunkCount).toBe(chMeta.totalChunkCount);
    expect(meta.startedAtMs).toBe(chMeta.startedAtMs);
    expect(meta.endedAtMs).toBe(chMeta.endedAtMs);
    // blocks-only: the legacy store is touched only by the completeness
    // guards (b: older chunk, c: per-window event totals), never for data
    expect(
      sqlLog.filter(
        (s) =>
          s.includes('session_replay_chunks') &&
          !s.includes('SELECT 1 AS older') &&
          !s.includes('any(events_count) AS ev'),
      ),
    ).toEqual([]);
    expect(sqlLog.filter((s) => s.includes('SELECT 1 AS older'))).toHaveLength(
      1,
    );

    const page = await svc.getSessionReplayChunksFrom('s', 'p1', 0, 'w');
    expect(stripItems(page.data)).toEqual(stripItems(chPage.data));
    expect(page.hasMore).toBe(false);
  });

  it('refs straddle COMPLETE_SINCE → legacy only (one source per session, never mixed)', async () => {
    const early = mkChunk('p1', 'm', 'w', 0, '2026-10-09T13:00:00.000Z', true);
    const later = [
      mkChunk('p1', 'm', 'w', 1, '2026-10-09T13:20:00.000Z'),
      mkChunk('p1', 'm', 'w', 2, '2026-10-09T13:20:01.000Z'),
    ];
    // CH was dual-written for the whole blocks period → complete; blocks only
    // have the chunks written after the rollout.
    chChunks.push(early, ...later);
    addBlock(later, 7, '2026-10-09T13:20:02Z');

    const meta = await svc.getSessionReplayMeta('m', 'p1');
    expect(meta.source).toBe('ch');
    expect(meta.totalChunkCount).toBe(3);
    const page = await svc.getSessionReplayChunksFrom('m', 'p1', 0, 'w');
    expect(page.data.map((d) => d.chunkIndex)).toEqual([0, 1, 2]);
    expect(page.data[0]!.startedAtMs).toBe(ms(early.started_at));
  });

  it('blocks session: a window the blocks do not hold falls back to legacy', async () => {
    const inBlocks = mkChunk(
      'p1',
      'x',
      'w1',
      0,
      '2026-10-11T00:00:00.000Z',
      true,
    );
    const chOnly = mkChunk(
      'p1',
      'x',
      'w2',
      0,
      '2026-10-11T00:00:03.000Z',
      true,
    );
    chChunks.push(inBlocks, chOnly);
    addBlock([inBlocks], 1, '2026-10-11T00:00:01Z');

    const w1 = await svc.getSessionReplayChunksFrom('x', 'p1', 0, 'w1');
    expect(w1.data).toHaveLength(1);
    const w2 = await svc.getSessionReplayChunksFrom('x', 'p1', 0, 'w2');
    expect(w2.data.map((d) => d.startedAtMs)).toEqual([ms(chOnly.started_at)]);
    const seg = await svc.getSessionWindowSegments('x', 'p1', 'w2');
    expect(seg).toEqual([
      { startMs: ms(chOnly.started_at), endMs: ms(chOnly.ended_at) },
    ]);
    const around = await svc.getSessionReplayChunksAroundTime(
      'x',
      'p1',
      ms(chOnly.started_at),
      1000,
      'w2',
    );
    expect(around.data).toHaveLength(1);
    const range = await svc.getSessionReplayChunksByIndexRange(
      'x',
      'p1',
      0,
      5,
      'w2',
    );
    expect(range.data).toHaveLength(1);
  });

  it('blocks session: a Blob read failure serves that page from legacy', async () => {
    const c = mkChunk('p1', 'e', 'w', 0, '2026-10-11T00:00:00.000Z', true);
    chChunks.push(c);
    addBlock([c], 1, '2026-10-11T00:00:01Z');
    expect((await svc.getSessionReplayMeta('e', 'p1')).source).toBe('blocks');
    blobFails = true;
    const page = await svc.getSessionReplayChunksFrom('e', 'p1', 0, 'w');
    expect(page.data.map((d) => d.startedAtMs)).toEqual([ms(c.started_at)]);
  });

  it('resumed old session (legacy chunks before the blocks, refs after COMPLETE_SINCE) → legacy via guard (b)', async () => {
    // e.g. frameo b5a0e3cb…: thousands of CH chunks on Oct 8, idle, then a few
    // blocks on Oct 11 - refs pass (a) but hold only the tail.
    const old = [
      mkChunk('p1', 'r', 'w', 0, '2026-10-08T10:00:00.000Z', true),
      mkChunk('p1', 'r', 'w', 1, '2026-10-08T10:00:01.000Z'),
    ];
    const tail = mkChunk('p1', 'r', 'w', 0, '2026-10-11T23:04:00.000Z', true);
    chChunks.push(...old, tail);
    addBlock([tail], 50, '2026-10-11T23:04:01Z');
    const meta = await svc.getSessionReplayMeta('r', 'p1');
    expect(meta.source).toBe('ch');
    expect(meta.totalChunkCount).toBe(3);
    const page = await svc.getSessionReplayChunksFrom('r', 'p1', 0, 'w');
    expect(page.data).toHaveLength(3);
  });

  it('resumed session whose older chunks are only in the cold archive → legacy via guard (b)', async () => {
    const tail = mkChunk('p1', 'ra', 'w', 0, '2026-10-11T23:04:00.000Z', true);
    chChunks.push(tail);
    addBlock([tail], 50, '2026-10-11T23:04:01Z');
    archiveRows.push({
      project_id: 'p1',
      session_id: 'ra',
      first_ms: Date.parse('2026-10-08T10:00:00.000Z'),
    });
    expect((await svc.getSessionReplayMeta('ra', 'p1')).source).toBe('ch');
  });

  it('rollout-window session (blocks miss mid-session chunks, refs before COMPLETE_SINCE) → legacy via (a)', async () => {
    // e.g. c1ea56bc…: started Oct 9 13:24 during the worker rollout; blocks
    // begin at the right chunk but miss chunks a not-yet-dual pod consumed.
    const cs = [0, 1, 2, 3].map((i) =>
      mkChunk('p1', 'g', 'w', i, `2026-10-09T13:24:0${i}.000Z`, i === 0),
    );
    chChunks.push(...cs);
    addBlock([cs[0]!, cs[1]!], 10, '2026-10-09T13:24:02Z');
    addBlock([cs[3]!], 12, '2026-10-09T13:24:04Z'); // cs[2] never reached blocks
    sqlLog.length = 0;
    const meta = await svc.getSessionReplayMeta('g', 'p1');
    expect(meta.source).toBe('ch');
    expect(meta.totalChunkCount).toBe(4);
    // (a) alone decides - no guard query needed
    expect(sqlLog.some((q) => q.includes('SELECT 1 AS older'))).toBe(false);
  });

  it('clean session (refs after COMPLETE_SINCE, legacy starts at the same chunk) → blocks', async () => {
    const cs = [
      mkChunk('p1', 'k', 'w', 0, '2026-10-11T08:00:00.000Z', true),
      mkChunk('p1', 'k', 'w', 1, '2026-10-11T08:00:01.000Z'),
    ];
    chChunks.push(...cs); // dual-written: CH first chunk == blocks first chunk
    archiveRows.push({
      project_id: 'p1',
      session_id: 'k',
      first_ms: ms(cs[0]!.started_at), // equal, not older (strict <)
    });
    addBlock(cs, 1, '2026-10-11T08:00:02Z');
    expect((await svc.getSessionReplayMeta('k', 'p1')).source).toBe('blocks');
  });

  it('mid-session chunk missing from blocks (shadow write failed) → legacy', async () => {
    const cs = [
      mkChunk('p1', 'gap', 'w', 0, '2026-10-11T08:00:00.000Z', true),
      mkChunk('p1', 'gap', 'w', 1, '2026-10-11T08:00:01.000Z'),
      mkChunk('p1', 'gap', 'w', 2, '2026-10-11T08:00:02.000Z'),
    ];
    chChunks.push(...cs);
    // Same start as CH, so guards (a)+(b) pass; chunk 1's block never landed.
    addBlock([cs[0]!], 1, '2026-10-11T08:00:01Z');
    addBlock([cs[2]!], 2, '2026-10-11T08:00:03Z');
    expect((await svc.getSessionReplayMeta('gap', 'p1')).source).toBe('ch');
  });

  it('tab only in CH (its blocks never written) → legacy', async () => {
    const a = mkChunk('p1', 'tab', 'wa', 0, '2026-10-11T08:00:00.000Z', true);
    const b = mkChunk('p1', 'tab', 'wb', 0, '2026-10-11T08:00:05.000Z', true);
    chChunks.push(a, b);
    addBlock([a], 1, '2026-10-11T08:00:01Z');
    expect((await svc.getSessionReplayMeta('tab', 'p1')).source).toBe('ch');
  });

  it('duplicate blocks (redelivery) do not trip the guard → blocks', async () => {
    const cs = [
      mkChunk('p1', 'dup', 'w', 0, '2026-10-11T08:00:00.000Z', true),
      mkChunk('p1', 'dup', 'w', 1, '2026-10-11T08:00:01.000Z'),
    ];
    chChunks.push(...cs, cs[1]!); // CH also holds a redelivered duplicate
    addBlock(cs, 1, '2026-10-11T08:00:02Z');
    addBlock([cs[1]!], 2, '2026-10-11T08:00:03Z');
    expect((await svc.getSessionReplayMeta('dup', 'p1')).source).toBe('blocks');
  });

  it('a duplicated block cannot mask a missing chunk (distinct chunk count) → legacy', async () => {
    const cs = [
      mkChunk('p1', 'mask', 'w', 0, '2026-10-11T08:00:00.000Z', true),
      mkChunk('p1', 'mask', 'w', 1, '2026-10-11T08:00:01.000Z'),
      mkChunk('p1', 'mask', 'w', 2, '2026-10-11T08:00:02.000Z'),
    ];
    chChunks.push(...cs);
    // chunk 1 landed twice, chunk 2 never: summed events would match CH (3).
    addBlock([cs[0]!, cs[1]!], 1, '2026-10-11T08:00:02Z');
    addBlock([cs[1]!], 2, '2026-10-11T08:00:03Z');
    expect((await svc.getSessionReplayMeta('mask', 'p1')).source).toBe('ch');
  });

  it('live tab: CH chunks newer than the blocks and still in flight are not a gap → blocks', async () => {
    const now = Date.now();
    const iso = (t: number) => new Date(t).toISOString();
    const cs = [
      mkChunk('p1', 'live', 'w', 0, iso(now - 30_000), true),
      mkChunk('p1', 'live', 'w', 1, iso(now - 20_000)),
      mkChunk('p1', 'live', 'w', 2, iso(now - 10_000)), // CH insert done, shadow not yet
    ];
    const tab = mkChunk('p1', 'live', 'w2', 0, iso(now - 5_000), true); // new tab, first batch in flight
    chChunks.push(...cs, tab);
    archiveRows.push({ project_id: 'p1', session_id: 'live', first_ms: now - 30_000 });
    addBlock([cs[0]!, cs[1]!], 1, iso(now - 15_000));
    expect((await svc.getSessionReplayMeta('live', 'p1')).source).toBe('blocks');
  });

  it('Kafka backlog: chunks recorded 10 min ago, blocks written just now, tail in flight → blocks', async () => {
    const now = Date.now();
    const iso = (t: number) => new Date(t).toISOString();
    const cs = [
      mkChunk('p1', 'lag', 'w', 0, iso(now - 600_000), true),
      mkChunk('p1', 'lag', 'w', 1, iso(now - 590_000)), // CH insert done, shadow pending
    ];
    chChunks.push(...cs);
    archiveRows.push({ project_id: 'p1', session_id: 'lag', first_ms: now - 600_000 });
    addBlock([cs[0]!], 1, iso(now - 2_000)); // consumer is behind: written now
    expect((await svc.getSessionReplayMeta('lag', 'p1')).source).toBe('blocks');
  });

  it('a missing tail chunk past the in-flight grace is a gap → legacy', async () => {
    const cs = [
      mkChunk('p1', 'tail', 'w', 0, '2026-10-11T08:00:00.000Z', true),
      mkChunk('p1', 'tail', 'w', 1, '2026-10-11T08:00:01.000Z'),
    ];
    chChunks.push(...cs);
    addBlock([cs[0]!], 1, '2026-10-11T08:00:01Z');
    expect((await svc.getSessionReplayMeta('tail', 'p1')).source).toBe('ch');
  });

  it('guard error on a session CH no longer holds → retryable error, not an empty legacy replay', async () => {
    const c = mkChunk('p1', 'bo', 'w', 0, '2026-10-11T08:00:00.000Z', true);
    addBlock([c], 1, '2026-10-11T08:00:01Z'); // Blob-only: refs, no CH rows
    failGuard = true;
    await expect(svc.getSessionReplayMeta('bo', 'p1')).rejects.toMatchObject({
      name: 'ReplayTemporarilyUnavailableError',
      status: 503,
    });
    failGuard = false;
    expect((await svc.getSessionReplayMeta('bo', 'p1')).source).toBe('blocks');
  });

  it('guard query error → legacy (fail safe), not cached', async () => {
    const c = mkChunk('p1', 'ge', 'w', 0, '2026-10-11T08:00:00.000Z', true);
    chChunks.push(c);
    addBlock([c], 1, '2026-10-11T08:00:01Z');
    failGuard = true;
    expect((await svc.getSessionReplayMeta('ge', 'p1')).source).toBe('ch');
    failGuard = false; // recovers on the next read
    expect((await svc.getSessionReplayMeta('ge', 'p1')).source).toBe('blocks');
  });

  it('refs lookup failure → logged, falls back to legacy', async () => {
    chChunks.push(
      mkChunk('pfail', 'f', 'w', 0, '2026-10-11T00:00:00.000Z', true),
    );
    failRefsFor = 'f';
    const meta = await svc.getSessionReplayMeta('f', 'pfail');
    expect(meta.source).toBe('ch');
    expect(meta.totalChunkCount).toBe(1);
  });

  it('presence + has-replay include blocks for allow-listed projects only', async () => {
    addBlock(
      [mkChunk('p1', 'b', 'w', 0, '2026-10-11T00:00:00.000Z', true)],
      1,
      '2026-10-11T00:00:01Z',
    );
    await svc.sessionHasReplay('b', 'p1');
    expect(sqlLog.at(-1)).toContain('FROM session_replay_blocks');
    await svc.sessionHasReplay('b', 'p2');
    expect(sqlLog.at(-1)).not.toContain('session_replay_blocks');
    const sub = svc.buildReplayPresenceSubqueryForRange(
      'p1',
      '2026-10-01',
      '2026-10-12',
    );
    expect(sub).toContain('FROM session_replay_blocks');
    expect(
      svc.buildReplayPresenceSubqueryForRange('p2', '2026-10-01', '2026-10-12'),
    ).not.toContain('session_replay_blocks');
  });
});
