import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock only the two I/O edges: the blob append (returns a fake committed offset
// per blob) and the ClickHouse ref insert. Compression + grouping run for real.
const appends: { blobPath: string; block: Buffer }[] = [];
const blobLengths = new Map<string, number>();
const appendMock = vi.fn(async (blobPath: string, block: Buffer) => {
  appends.push({ blobPath, block });
  const byteStart = blobLengths.get(blobPath) ?? 0;
  blobLengths.set(blobPath, byteStart + block.length);
  return { byteStart, byteEnd: byteStart + block.length };
});
vi.mock('../blob/replay-blocks', async (importOriginal) => {
  const real = await importOriginal<typeof import('../blob/replay-blocks')>();
  return {
    ...real,
    appendReplayBlock: (p: string, b: Buffer) => appendMock(p, b),
  };
});

const inserted: any[] = [];
const insertMock = vi.fn(async ({ values }: { values: any[] }) => {
  inserted.push(...values);
});
vi.mock('../clickhouse/client', () => ({
  TABLE_NAMES: { session_replay_blocks: 'session_replay_blocks' },
  ch: { insert: (args: any) => insertMock(args) },
}));

const { writeSessionReplayBlocks } = await import('./replay-block.service');
const { decompressReplayBlock } = await import('../blob/replay-blocks');

const chunk = (
  sessionId: string,
  chunkIndex: number,
  startedAt: string,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    project_id: 'proj',
    session_id: sessionId,
    window_id: `win-${sessionId}`,
    chunk_index: chunkIndex,
    started_at: startedAt,
    ended_at: startedAt,
    events_count: 3,
    is_full_snapshot: chunkIndex === 0,
    payload: `[{"chunk":${chunkIndex}}]`,
    ...extra,
  });

describe('writeSessionReplayBlocks', () => {
  beforeEach(() => {
    appends.length = 0;
    inserted.length = 0;
    blobLengths.clear();
    appendMock.mockClear();
    insertMock.mockClear();
  });

  it('writes one block + one ref per session, in (started_at, chunk_index) order', async () => {
    const items = [
      // session A arrives out of order across offsets 12, 10, 11
      { line: chunk('A', 2, '2026-10-01 10:00:02.000'), offset: 12 },
      { line: chunk('B', 0, '2026-10-01 10:00:00.500'), offset: 13 },
      { line: chunk('A', 0, '2026-10-01 10:00:00.000'), offset: 10 },
      { line: chunk('A', 1, '2026-10-01 10:00:01.000'), offset: 11 },
    ];
    const res = await writeSessionReplayBlocks(items);

    expect(res.blocks).toBe(2);
    expect(appendMock).toHaveBeenCalledTimes(2);
    expect(insertMock).toHaveBeenCalledTimes(1); // one ref insert per batch

    const refA = inserted.find((r) => r.session_id === 'A');
    const refB = inserted.find((r) => r.session_id === 'B');
    // block_index = the session's MIN Kafka offset, not its first-seen offset
    expect(refA.block_index).toBe(10);
    expect(refB.block_index).toBe(13);
    expect(refA.chunk_lo).toBe(0);
    expect(refA.chunk_hi).toBe(2);
    expect(refA.events_count).toBe(9);
    expect(refA.first_started_at).toBe('2026-10-01 10:00:00.000');
    expect(refA.last_started_at).toBe('2026-10-01 10:00:02.000');
    expect(refA.window_id).toBe('win-A');
    expect(refA.codec).toBe('zstd');

    // the block holds A's lines sorted by (started_at, chunk_index), byte-identical
    const blockA = appends.find((a) => a.blobPath.includes('session=A'))!;
    expect(decompressReplayBlock(blockA.block)).toEqual([
      items[2]!.line,
      items[3]!.line,
      items[0]!.line,
    ]);
    expect(refA.size_bytes).toBe(blockA.block.length);
    expect(refA.byte_end - refA.byte_start).toBe(blockA.block.length);
    expect(res.bytes).toBe(refA.size_bytes + refB.size_bytes);
  });

  it('splits one session into one block per window (tab)', async () => {
    const items = [
      { line: chunk('A', 0, '2026-10-01 10:00:00.000'), offset: 5 },
      {
        line: chunk('A', 0, '2026-10-01 10:00:00.500', { window_id: 'tab-2' }),
        offset: 6,
      },
      { line: chunk('A', 1, '2026-10-01 10:00:01.000'), offset: 7 },
    ];
    const res = await writeSessionReplayBlocks(items);
    expect(res.blocks).toBe(2);
    const byWindow = new Map(inserted.map((r) => [r.window_id, r]));
    expect(byWindow.get('win-A').block_index).toBe(5);
    expect(byWindow.get('win-A').chunk_hi).toBe(1);
    expect(byWindow.get('tab-2').block_index).toBe(6);
    expect(byWindow.get('tab-2').chunk_lo).toBe(0);
    // both windows of the session append to the same session blob
    expect(byWindow.get('win-A').blob_path).toBe(
      byWindow.get('tab-2').blob_path,
    );
  });

  it('ties on started_at are broken by chunk_index', async () => {
    const t = '2026-10-01 10:00:00.000';
    const items = [
      { line: chunk('A', 5, t), offset: 1 },
      { line: chunk('A', 3, t), offset: 2 },
    ];
    await writeSessionReplayBlocks(items);
    expect(decompressReplayBlock(appends[0]!.block)).toEqual([
      items[1]!.line,
      items[0]!.line,
    ]);
  });

  it('records the committed offset returned by the append for consecutive blocks', async () => {
    await writeSessionReplayBlocks([
      { line: chunk('A', 0, '2026-10-01 10:00:00.000'), offset: 1 },
    ]);
    await writeSessionReplayBlocks([
      { line: chunk('A', 1, '2026-10-01 10:00:01.000'), offset: 2 },
    ]);
    const [first, second] = inserted;
    expect(first.byte_start).toBe(0);
    expect(second.byte_start).toBe(first.byte_end);
    expect(second.blob_path).toBe(first.blob_path);
  });

  it('skips malformed lines and writes nothing for an empty batch', async () => {
    expect(await writeSessionReplayBlocks([])).toEqual({ blocks: 0, bytes: 0 });
    const res = await writeSessionReplayBlocks([
      { line: 'not json', offset: 1 },
      { line: chunk('A', 0, '2026-10-01 10:00:00.000'), offset: 2 },
    ]);
    expect(res.blocks).toBe(1);
    expect(inserted[0].block_index).toBe(2);
  });

  it('propagates an append failure (caller decides) and inserts no refs', async () => {
    appendMock.mockRejectedValueOnce(new Error('azure down'));
    await expect(
      writeSessionReplayBlocks([
        { line: chunk('A', 0, '2026-10-01 10:00:00.000'), offset: 1 },
      ]),
    ).rejects.toThrow('azure down');
    expect(insertMock).not.toHaveBeenCalled();
  });
});
