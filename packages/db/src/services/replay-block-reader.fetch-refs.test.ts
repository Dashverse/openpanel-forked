import { describe, expect, it, vi } from 'vitest';

// Own file: the chunk_keys probe memoizes in module state, and these tests need
// it to find the column.
vi.mock('../clickhouse/client', () => ({
  TABLE_NAMES: { session_replay_blocks: 'session_replay_blocks' },
  chQuery: vi.fn(async () => [{ c: 1 }]),
}));

const { chQuery } = await import('../clickhouse/client');
const { fetchReplayBlockRefs } = await import('./replay-block-reader');

// A ref row as chQuery hands it back from prod (session 3540f328, frameo).
const refRow = {
  window_id: 'w1',
  block_index: '299120',
  blob_path: 'blocks/dt=2026-11-04/project=frameo/session=s1.zst',
  byte_start: '0',
  byte_end: '512',
  created_ms: '1793821812000',
  first_ms: '1793821811204',
  last_ms: '1793821811275',
  events_count: '2',
  size_bytes: '512',
  chunk_keys_json:
    '[[0,"1793821811204","1793821811235",1],[1,"1793821811275","1793821820036",0]]',
};

describe('fetchReplayBlockRefs', () => {
  it('reads chunk_keys as JSON text, out of reach of chQuery Int coercion', async () => {
    vi.mocked(chQuery)
      .mockResolvedValueOnce([{ c: 1 }])
      .mockResolvedValueOnce([refRow]);

    const [ref] = await fetchReplayBlockRefs('frameo', 's1');

    // chQuery parseFloat()s any column whose type contains Int; selecting the
    // raw Array(Tuple(UInt32, Int64, Int64, UInt8)) turned it into 0 and broke
    // every replay open.
    const sql = vi.mocked(chQuery).mock.calls.at(-1)?.[0] ?? '';
    expect(sql).toContain('toJSONString(chunk_keys) AS chunk_keys_json');
    expect(ref?.chunkKeys).toEqual([
      [0, 1793821811204, 1793821811235, 1],
      [1, 1793821811275, 1793821820036, 0],
    ]);
  });

  it('accepts tuples serialized as objects', async () => {
    vi.mocked(chQuery).mockResolvedValueOnce([
      {
        ...refRow,
        chunk_keys_json:
          '[{"1":0,"2":"1793821811204","3":"1793821811235","4":1}]',
      },
    ]);

    const [ref] = await fetchReplayBlockRefs('frameo', 's1');

    expect(ref?.chunkKeys).toEqual([[0, 1793821811204, 1793821811235, 1]]);
  });

  it('gives no keys for a ref written before migration 26', async () => {
    vi.mocked(chQuery).mockResolvedValueOnce([
      { ...refRow, chunk_keys_json: '[]' },
    ]);

    const [ref] = await fetchReplayBlockRefs('frameo', 's1');

    expect(ref?.chunkKeys).toEqual([]);
  });
});
