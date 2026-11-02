import { describe, expect, it, vi } from 'vitest';

// Own file: the probe memoizes its answer in module state, so it needs a fresh
// module registry to be observed making its one query.
vi.mock('../clickhouse/client', () => ({
  TABLE_NAMES: { session_replay_blocks: 'session_replay_blocks' },
  chQuery: vi.fn(async () => [{ c: 1 }]),
}));

const { chQuery } = await import('../clickhouse/client');
const { replayBlocksHaveChunkKeys } = await import('./replay-block-reader');

describe('chunk_keys probe', () => {
  it('opts out of the query cache, which a system-table read cannot use', async () => {
    await expect(replayBlocksHaveChunkKeys()).resolves.toBe(true);

    const [sql, settings] = vi.mocked(chQuery).mock.calls.at(-1) ?? [];
    expect(sql).toContain('system.columns');
    // Prod's CLICKHOUSE_SETTINGS set use_query_cache=1 for every query. With the
    // cache on, ClickHouse rejects this probe before it runs: `currentDatabase()`
    // is non-deterministic (704) and `system.columns` is a system table (719).
    // That is not a cache miss, it is an exception, and the catch below it used
    // to swallow it into "column absent" - which disabled the chunk_keys read
    // path in prod for the 12 days after migration 26 landed.
    expect(settings).toMatchObject({ use_query_cache: 0 });
  });
});
