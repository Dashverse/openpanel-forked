import { beforeEach, describe, expect, it, vi } from 'vitest';

// Chainable Redis MULTI stub + a captured ch.insert, hoisted so the vi.mock
// factories below can reference them.
const mocks = vi.hoisted(() => {
  const makeChain = () => {
    const chain: Record<string, any> = {};
    for (const m of ['rpush', 'incr', 'ltrim', 'decrby']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.exec = vi.fn(async () => []);
    return chain;
  };
  const redis = {
    multi: vi.fn(() => makeChain()),
    lrange: vi.fn(async () => [] as string[]),
    llen: vi.fn(async () => 0),
    memory: vi.fn(async () => 0),
  };
  const chInsert = vi.fn(async () => undefined);
  return { redis, chInsert };
});

vi.mock('@openpanel/redis', () => ({
  getRedisCache: () => mocks.redis,
  runEvery: vi.fn(),
}));

// base-buffer imports cronQueue from @openpanel/queue, which instantiates a real
// BullMQ queue (Redis connection) at module load. Stub it so this unit test
// needs no infra.
vi.mock('@openpanel/queue', () => ({
  cronQueue: {
    add: vi.fn(),
    upsertJobScheduler: vi.fn(),
    getJobSchedulers: vi.fn(async () => []),
    removeJobScheduler: vi.fn(),
  },
}));

vi.mock('../clickhouse/client', () => ({
  ch: { insert: mocks.chInsert },
  TABLE_NAMES: { alias: 'profile_aliases' },
}));

import { AliasBuffer } from './alias-buffer';

const row = (project: string, alias: string, profile: string, at: string) =>
  JSON.stringify({
    project_id: project,
    alias,
    profile_id: profile,
    created_at: at,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AliasBuffer in-batch dedup', () => {
  it('collapses repeated (project, alias, profile) mappings to one row, keeping the latest', async () => {
    const buffer = new AliasBuffer();

    // The proxy re-emits the same mapping every batch: 3 copies of A->X plus
    // one B->Y, all in one flush window.
    mocks.redis.lrange.mockResolvedValueOnce([
      row('p1', 'anonA', 'userX', '2026-09-24 10:00:00'),
      row('p1', 'anonA', 'userX', '2026-09-24 10:00:05'),
      row('p1', 'anonA', 'userX', '2026-09-24 10:00:09'),
      row('p1', 'anonB', 'userY', '2026-09-24 10:00:03'),
    ]);

    await buffer.processBuffer();

    expect(mocks.chInsert).toHaveBeenCalledTimes(1);
    const { values, table } = mocks.chInsert.mock.calls[0]![0] as {
      table: string;
      values: Array<{ alias: string; profile_id: string; created_at: string }>;
    };
    expect(table).toBe('profile_aliases');
    // 4 buffered rows -> 2 unique mappings.
    expect(values).toHaveLength(2);

    const a = values.find((v) => v.alias === 'anonA');
    const b = values.find((v) => v.alias === 'anonB');
    expect(a?.profile_id).toBe('userX');
    // Latest occurrence wins for the duplicate.
    expect(a?.created_at).toBe('2026-09-24 10:00:09');
    expect(b?.profile_id).toBe('userY');
  });

  it('does nothing when the buffer is empty', async () => {
    const buffer = new AliasBuffer();
    mocks.redis.lrange.mockResolvedValueOnce([]);

    await buffer.processBuffer();

    expect(mocks.chInsert).not.toHaveBeenCalled();
  });

  it('trims exactly the rows it read (by raw count, not the deduped count)', async () => {
    const buffer = new AliasBuffer();
    const rows = [
      row('p1', 'anonA', 'userX', '2026-09-24 10:00:00'),
      row('p1', 'anonA', 'userX', '2026-09-24 10:00:05'),
    ];
    mocks.redis.lrange.mockResolvedValueOnce(rows);

    // Capture the ltrim call on the MULTI used for cleanup.
    let ltrimArgs: unknown[] | undefined;
    mocks.redis.multi.mockImplementationOnce(() => {
      const chain: Record<string, any> = {};
      chain.ltrim = vi.fn((...args: unknown[]) => {
        ltrimArgs = args;
        return chain;
      });
      chain.decrby = vi.fn(() => chain);
      chain.exec = vi.fn(async () => []);
      return chain;
    });

    await buffer.processBuffer();

    // Inserted 1 deduped row, but must trim the 2 raw rows consumed.
    expect(ltrimArgs).toEqual(['{alias_buffer}:aliases', 2, -1]);
  });
});
