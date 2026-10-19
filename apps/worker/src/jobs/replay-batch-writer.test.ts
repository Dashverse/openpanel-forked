import { describe, expect, it, vi } from 'vitest';
import {
  parseBlobOnlyProjectIds,
  positiveIntEnv,
  replayLineProjectId,
  replayRetryBackoffMs,
  writeReplayBatch,
} from './replay-batch-writer';

const line = (project: string, i: number) =>
  JSON.stringify({
    project_id: project,
    session_id: `s-${project}`,
    window_id: 'w',
    chunk_index: i,
    started_at: '2026-10-12T00:00:00.000Z',
    ended_at: '2026-10-12T00:00:01.000Z',
    events_count: 1,
    is_full_snapshot: i === 0,
    payload: '[]',
  });

const batch = [
  { line: line('frameo', 0), offset: 1 },
  { line: line('dashreels', 0), offset: 2 },
  { line: line('frameo', 1), offset: 3 },
  { line: '{not json', offset: 4 },
];

function deps(opts: { blocksFail?: (projects: string[]) => boolean } = {}) {
  const chCalls: string[][] = [];
  const blockCalls: string[][] = [];
  const d = {
    insertChunks: vi.fn(async (lines: string[]) => {
      chCalls.push(lines);
    }),
    writeBlocks: vi.fn(async (items: { line: string }[]) => {
      const projects = items.map((i) => replayLineProjectId(i.line) ?? '?');
      blockCalls.push(projects);
      if (opts.blocksFail?.(projects)) throw new Error('azure down');
      return { blocks: 1, bytes: 10 };
    }),
    onShadowError: vi.fn(),
    onFailClosed: vi.fn(),
  };
  return { d, chCalls, blockCalls };
}

describe('replayLineProjectId', () => {
  it('reads project_id from the prefix, falls back to a full parse, null if unparseable', () => {
    expect(replayLineProjectId(line('frameo', 0))).toBe('frameo');
    expect(replayLineProjectId('{"a":1,"project_id":"x"}')).toBe('x');
    expect(replayLineProjectId('{"project_id":"we\\"ird"}')).toBe('we"ird');
    expect(replayLineProjectId('{nope')).toBeNull();
  });
  it('parses the CSV', () => {
    expect(Array.from(parseBlobOnlyProjectIds(' frameo, ,dashreels '))).toEqual(
      ['frameo', 'dashreels'],
    );
    expect(parseBlobOnlyProjectIds(undefined).size).toBe(0);
  });
});

describe('writeReplayBatch', () => {
  it('mode off: CH only, every line', async () => {
    const { d, chCalls } = deps();
    await writeReplayBatch(
      batch,
      { mode: 'off', blobOnlyProjectIds: new Set(['frameo']) },
      d,
    );
    expect(chCalls).toEqual([batch.map((b) => b.line)]);
    expect(d.writeBlocks).not.toHaveBeenCalled();
  });

  it('dual, no Blob-only: CH everything + one shadow block write (unchanged behaviour)', async () => {
    const { d, chCalls, blockCalls } = deps();
    const res = await writeReplayBatch(
      batch,
      { mode: 'dual', blobOnlyProjectIds: new Set() },
      d,
    );
    expect(chCalls).toEqual([batch.map((b) => b.line)]);
    expect(blockCalls).toHaveLength(1);
    expect(res).toMatchObject({ chChunks: 4, blobOnlyChunks: 0, blocks: 1 });
  });

  it('dual + Blob-only: splits per project; Blob-only lines never reach CH', async () => {
    const { d, chCalls, blockCalls } = deps();
    const res = await writeReplayBatch(
      batch,
      { mode: 'dual', blobOnlyProjectIds: new Set(['frameo']) },
      d,
    );
    // unparseable line stays on CH (never written nowhere)
    expect(chCalls).toEqual([[line('dashreels', 0), '{not json']]);
    expect(blockCalls).toEqual([
      ['frameo', 'frameo'], // fail-closed write first
      ['dashreels', '?'], // shadow write
    ]);
    expect(res).toMatchObject({
      chChunks: 2,
      blobOnlyChunks: 2,
      blocks: 2,
      bytes: 20,
    });
  });

  it('Blob-only block failure THROWS (batch not resolved → redelivery)', async () => {
    const { d } = deps({ blocksFail: (p) => p.includes('frameo') });
    await expect(
      writeReplayBatch(
        batch,
        { mode: 'dual', blobOnlyProjectIds: new Set(['frameo']) },
        d,
      ),
    ).rejects.toThrow('azure down');
    expect(d.onFailClosed).toHaveBeenCalledTimes(1);
    expect(d.onShadowError).not.toHaveBeenCalled();
  });

  it('dual-project (shadow) block failure is swallowed + counted', async () => {
    const { d } = deps({ blocksFail: (p) => p.includes('dashreels') });
    const res = await writeReplayBatch(
      batch,
      { mode: 'dual', blobOnlyProjectIds: new Set(['frameo']) },
      d,
    );
    expect(d.onShadowError).toHaveBeenCalledTimes(1);
    expect(d.onFailClosed).not.toHaveBeenCalled();
    expect(res.blobOnlyChunks).toBe(2);
  });

  it('Blob-only blocks are written before the CH insert; a CH failure then throws', async () => {
    const { d } = deps();
    d.insertChunks.mockRejectedValueOnce(new Error('ch down'));
    await expect(
      writeReplayBatch(
        batch,
        { mode: 'dual', blobOnlyProjectIds: new Set(['frameo']) },
        d,
      ),
    ).rejects.toThrow('ch down');
    // Only the Blob-only write ran (redelivery just duplicates blocks); the
    // dual shadow write after the CH insert did not.
    expect(d.writeBlocks).toHaveBeenCalledTimes(1);
  });

  it('Blob outage fails the batch before any CH insert (no CH duplicates on retry)', async () => {
    const { d } = deps();
    d.writeBlocks.mockRejectedValueOnce(new Error('azure down'));
    await expect(
      writeReplayBatch(
        batch,
        { mode: 'dual', blobOnlyProjectIds: new Set(['frameo']) },
        d,
      ),
    ).rejects.toThrow('azure down');
    expect(d.insertChunks).not.toHaveBeenCalled();
  });

  it('batch of only Blob-only projects makes no CH insert', async () => {
    const { d } = deps();
    await writeReplayBatch(
      [{ line: line('frameo', 0), offset: 1 }],
      { mode: 'dual', blobOnlyProjectIds: new Set(['frameo']) },
      d,
    );
    expect(d.insertChunks).not.toHaveBeenCalled();
    expect(d.writeBlocks).toHaveBeenCalledTimes(1);
  });

  it('skips the shadow write when the batch deadline is nearly spent', async () => {
    const { d, chCalls, blockCalls } = deps();
    const skipped = vi.fn();
    const res = await writeReplayBatch(
      batch,
      { mode: 'dual', blobOnlyProjectIds: new Set(['frameo']) },
      { ...d, shadowBudgetOk: () => false, onShadowSkipped: skipped },
    );
    // Blob-only write + CH insert still happen; only the optional shadow goes.
    expect(blockCalls).toEqual([['frameo', 'frameo']]);
    expect(chCalls).toHaveLength(1);
    expect(skipped).toHaveBeenCalledTimes(1);
    expect(res.blocks).toBe(1);
  });
});

describe('retry helpers', () => {
  it('backs off 1s, 2s, 4s ... capped', () => {
    expect([1, 2, 3, 4, 6, 50].map((a) => replayRetryBackoffMs(a))).toEqual([
      1000, 2000, 4000, 8000, 30_000, 30_000,
    ]);
    expect(replayRetryBackoffMs(0)).toBe(1000);
    expect(replayRetryBackoffMs(9, 5000)).toBe(5000);
  });
  it('positiveIntEnv rejects NaN / non-positive', () => {
    expect(positiveIntEnv(undefined, 25)).toBe(25);
    expect(positiveIntEnv('abc', 25)).toBe(25);
    expect(positiveIntEnv('0', 25)).toBe(25);
    expect(positiveIntEnv('40000', 25)).toBe(40_000);
  });
});
