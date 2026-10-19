import { zstdCompressSync } from 'node:zlib';
import { encodeReplayFrames } from '@openpanel/common/replay-frames';
import { decompress } from 'fzstd';
import { describe, expect, it } from 'vitest';
import {
  type ReplayEvent,
  decodeReplayBlockLines,
  decodeReplayBlocksResponse,
  mergeChunkEvents,
  parseReplayTimestampMs,
  sortAndDedupeEvents,
} from './replay-block-decode';

const T = Date.parse('2026-10-11T00:00:00.000Z');

const ev = (type: number, ts: number, data: unknown = {}): ReplayEvent => ({
  type,
  timestamp: ts,
  data,
});

const line = (
  w: string,
  i: number,
  startedAt: string | number,
  events: ReplayEvent[],
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    project_id: 'p',
    session_id: 's',
    window_id: w,
    chunk_index: i,
    started_at: startedAt,
    ended_at: startedAt,
    events_count: events.length,
    is_full_snapshot: events.some((e) => e.type === 2),
    ...extra,
    payload: JSON.stringify(events),
  });

/** What the API sends: framed blocks, each one zstd frame of NDJSON lines. */
const response = (blocks: { key: string; lines: string[] }[]) =>
  encodeReplayFrames(
    blocks.map((b) => ({
      key: b.key,
      data: new Uint8Array(
        zstdCompressSync(Buffer.from(b.lines.map((l) => `${l}\n`).join(''))),
      ),
    })),
  );

describe('parseReplayTimestampMs', () => {
  it('matches the server parser on the formats blocks hold', () => {
    expect(parseReplayTimestampMs('2026-10-11T00:00:00.123Z')).toBe(T + 123);
    expect(parseReplayTimestampMs('2026-10-11 00:00:00.123')).toBe(T + 123);
    expect(parseReplayTimestampMs('2026-10-11 00:00:00.1239')).toBe(T + 123);
    expect(parseReplayTimestampMs('2026-10-11T05:30:00+05:30')).toBe(T);
    expect(parseReplayTimestampMs(T / 1000)).toBe(T);
    expect(parseReplayTimestampMs('nope')).toBeNaN();
  });
});

describe('sortAndDedupeEvents (PostHog process-all-snapshots rule)', () => {
  it('sorts by timestamp, stable for ties', () => {
    const out = sortAndDedupeEvents([
      ev(3, 30, { a: 1 }),
      ev(3, 10, { a: 2 }),
      ev(3, 30, { a: 3 }),
    ]).events;
    expect(out.map((e) => (e.data as { a: number }).a)).toEqual([2, 1, 3]);
  });

  it('drops exact duplicates sharing a timestamp (delay ignored), keeps distinct ones', () => {
    const out = sortAndDedupeEvents([
      ev(3, 10, { x: 1 }),
      { ...ev(3, 10, { x: 1 }), delay: 55 },
      ev(3, 10, { x: 2 }),
      ev(3, 11, { x: 1 }),
    ]).events;
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.timestamp)).toEqual([10, 10, 11]);
  });
});

describe('decodeReplayBlockLines', () => {
  it('scopes to the window, dedupes chunks and events within the block', () => {
    const a0 = [ev(4, T), ev(2, T + 1)];
    const a1 = [ev(3, T + 1000, { n: 1 })];
    const block = decodeReplayBlockLines(
      [
        line('w', 0, '2026-10-11T00:00:00.000Z', a0),
        line('other', 0, '2026-10-11T00:00:00.000Z', [ev(3, T + 5)]),
        line('w', 1, '2026-10-11T00:00:01.000Z', a1),
        // exact SDK retry of chunk 1 inside the same batch
        line('w', 1, '2026-10-11T00:00:01.000Z', a1),
        // a different chunk repeating an event of chunk 1 (same ts + body)
        line('w', 2, '2026-10-11T00:00:02.000Z', [
          ev(3, T + 1000, { n: 1 }),
          ev(3, T + 2000),
        ]),
        'not json',
      ],
      'w',
    );
    expect(block.chunks.map((c) => c.id)).toEqual([
      `w|0|${T}`,
      `w|1|${T + 1000}`,
      `w|2|${T + 2000}`,
    ]);
    expect(block.chunks[2]!.events.map((e) => e.timestamp)).toEqual([T + 2000]);
    expect(block.fullSnapshots).toEqual([T + 1]);
    expect(block.minTs).toBe(T);
    expect(block.maxTs).toBe(T + 2000);
  });

  it('tolerates bad payloads and missing timestamps', () => {
    const block = decodeReplayBlockLines([
      JSON.stringify({ window_id: 'w', chunk_index: 0, started_at: 'x' }),
      JSON.stringify({
        window_id: 'w',
        chunk_index: 1,
        started_at: '2026-10-11T00:00:00Z',
        payload: '{broken',
      }),
    ]);
    expect(block.chunks).toHaveLength(1);
    expect(block.chunks[0]!.events).toEqual([]);
    expect(block.minTs).toBeNull();
  });
});

describe('decodeReplayBlocksResponse (worker path, fzstd)', () => {
  it('decodes Node-zstd frames with the pure-JS decoder, one block per key', () => {
    const body = response([
      {
        key: '100.0',
        lines: [
          line('w', 0, '2026-10-11T00:00:00.000Z', [ev(4, T), ev(2, T + 1)]),
        ],
      },
      {
        key: '101.512',
        lines: [line('w', 1, '2026-10-11 00:00:01.000', [ev(3, T + 1000)])],
      },
      { key: 'c1.0', lines: [] },
    ]);
    const out = decodeReplayBlocksResponse(body, (d) => decompress(d), 'w');
    expect(Array.from(out.keys())).toEqual(['100.0', '101.512', 'c1.0']);
    expect(out.get('100.0')!.fullSnapshots).toEqual([T + 1]);
    expect(out.get('101.512')!.chunks[0]!.startedMs).toBe(T + 1000);
    expect(out.get('c1.0')!.chunks).toEqual([]);
  });

  it('a truncated body throws (the request counts as failed)', () => {
    const body = response([
      { key: 'k', lines: [line('w', 0, T / 1000, [ev(2, T)])] },
    ]);
    expect(() =>
      decodeReplayBlocksResponse(body.subarray(0, body.length - 2), (d) =>
        decompress(d),
      ),
    ).toThrow();
  });
});

describe('mergeChunkEvents (across blocks)', () => {
  it('skips chunks already applied from another (redelivered) block and merges in time order', () => {
    const first = decodeReplayBlockLines([
      line('w', 0, T / 1000, [ev(4, T), ev(2, T + 1)]),
      line('w', 1, (T + 1000) / 1000, [ev(3, T + 1000)]),
    ]);
    const redelivered = decodeReplayBlockLines([
      line('w', 1, (T + 1000) / 1000, [ev(3, T + 1000)]),
      line('w', 2, (T + 2000) / 1000, [ev(3, T + 2000)]),
    ]);
    const seen = new Set<string>();
    const a = mergeChunkEvents(first.chunks, seen);
    const b = mergeChunkEvents(redelivered.chunks, seen);
    expect(a.map((e) => e.timestamp)).toEqual([T, T + 1, T + 1000]);
    expect(b.map((e) => e.timestamp)).toEqual([T + 2000]);
  });

  it('merges chunks out of order into one sorted list', () => {
    const blk = decodeReplayBlockLines([
      line('w', 1, (T + 1000) / 1000, [ev(3, T + 1500)]),
      line('w', 0, T / 1000, [ev(2, T), ev(3, T + 1200)]),
    ]);
    expect(
      mergeChunkEvents(blk.chunks, new Set()).map((e) => e.timestamp),
    ).toEqual([T, T + 1200, T + 1500]);
  });
});
