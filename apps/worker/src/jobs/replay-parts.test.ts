import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type ReassembleOptions,
  type ReplayKafkaMessage,
  reassembleReplayBatch,
} from './replay-parts';

// decode = utf8 toString, so a "compressed" value is just the line's bytes and
// a split set is the line cut into slices. Lines starting with '!' fail decode.
const decode = (v: Uint8Array, _encoding?: string) => {
  const s = Buffer.from(v).toString('utf8');
  if (s.startsWith('!')) throw new Error('bad lz4');
  return s;
};

const T0 = 1_760_000_000_000;

const opts = (o: Partial<ReassembleOptions> = {}): ReassembleOptions => ({
  decode,
  maxParts: 32,
  abandonAfterMs: 120_000,
  atTail: true,
  maxBytesPerPartition: 16 * 1024 * 1024,
  maxMessageBytes: 950_000,
  headBlockedMs: 0,
  maxHeadBlockedMs: 600_000,
  ...o,
});

const legacy = (offset: number, line: string, ts = T0): ReplayKafkaMessage => ({
  offset: String(offset),
  timestamp: String(ts),
  value: Buffer.from(line),
  headers: { 'content-encoding': 'lz4' },
});

const part = (
  offset: number,
  chunkId: string,
  index: number,
  count: number,
  bytes: string,
  ts = T0,
  extra: Record<string, string> = {},
): ReplayKafkaMessage => ({
  offset: String(offset),
  timestamp: String(ts),
  value: Buffer.from(bytes),
  headers: {
    'content-encoding': 'lz4',
    'x-replay-chunk-id': chunkId,
    'x-replay-part': String(index),
    'x-replay-parts': String(count),
    ...extra,
  },
});

// line 'ABCDEFGHI' as 3 parts
const BIG = 'ABCDEFGHI';
const bigParts = (id: string, offsets: [number, number, number], ts = T0) => [
  part(offsets[0], id, 0, 3, 'ABC', ts),
  part(offsets[1], id, 1, 3, 'DEF', ts),
  part(offsets[2], id, 2, 3, 'GHI', ts),
];

const byOffset = (msgs: ReplayKafkaMessage[]) =>
  [...msgs].sort((a, b) => Number(a.offset) - Number(b.offset));

describe('reassembleReplayBatch', () => {
  it('passes legacy messages through untouched and resolves the whole batch', () => {
    const r = reassembleReplayBatch(
      [legacy(5, 'a'), legacy(6, 'b'), legacy(7, 'c')],
      opts(),
    );
    expect(r.lines).toEqual([
      { line: 'a', offset: 5 },
      { line: 'b', offset: 6 },
      { line: 'c', offset: 7 },
    ]);
    expect(r.legacy).toBe(3);
    expect(r.resolveThrough).toBe('7');
    expect(r.blockedAt).toBeNull();
    expect(r.dropped).toEqual([]);
  });

  it('joins a complete set in part order at the offset of its first part', () => {
    const r = reassembleReplayBatch(bigParts('c1', [10, 11, 12]), opts());
    expect(r.lines).toEqual([{ line: BIG, offset: 10 }]);
    expect(r.reassembled).toBe(1);
    expect(r.resolveThrough).toBe('12');
  });

  it('reassembles across interleaved messages from other sessions, in offset order', () => {
    const [p0, p1, p2] = bigParts('c1', [11, 13, 16]);
    const r = reassembleReplayBatch(
      byOffset([
        legacy(10, 'x'),
        p0!,
        legacy(12, 'y'),
        p1!,
        legacy(14, 'z'),
        legacy(15, 'w'),
        p2!,
        legacy(17, 'v'),
      ]),
      opts(),
    );
    expect(r.lines.map((l) => [l.line, l.offset])).toEqual([
      ['x', 10],
      [BIG, 11],
      ['y', 12],
      ['z', 14],
      ['w', 15],
      ['v', 17],
    ]);
    expect(r.resolveThrough).toBe('17');
  });

  it('joins by declared index, not arrival order (defensive)', () => {
    const r = reassembleReplayBatch(
      [
        part(1, 'c1', 0, 3, 'ABC'),
        part(2, 'c1', 2, 3, 'GHI'),
        part(3, 'c1', 1, 3, 'DEF'),
      ],
      opts(),
    );
    expect(r.lines).toEqual([{ line: BIG, offset: 1 }]);
  });

  it('cuts at an incomplete tail set: writes and resolves only what precedes it', () => {
    const r = reassembleReplayBatch(
      [
        legacy(20, 'a'),
        part(21, 'c1', 0, 3, 'ABC'),
        legacy(22, 'b'),
        part(23, 'c1', 1, 3, 'DEF'),
      ],
      opts(),
    );
    expect(r.lines).toEqual([{ line: 'a', offset: 20 }]);
    expect(r.resolveThrough).toBe('20');
    expect(r.blockedAt).toBe('21');
    expect(r.dropped).toEqual([]);
  });

  it('resolves nothing when the incomplete set is the batch head (waits)', () => {
    const r = reassembleReplayBatch(
      [part(21, 'c1', 0, 3, 'ABC'), legacy(22, 'b')],
      opts({ atTail: true }),
    );
    expect(r.lines).toEqual([]);
    expect(r.resolveThrough).toBeNull();
    expect(r.blockedAt).toBe('21');
  });

  it('after the cut, the redelivered batch completes the set without rewriting earlier lines', () => {
    const first = reassembleReplayBatch(
      [legacy(20, 'a'), part(21, 'c1', 0, 3, 'ABC'), legacy(22, 'b')],
      opts(),
    );
    expect(first.resolveThrough).toBe('20');
    // Kafka redelivers from 21, now with the rest of the set
    const second = reassembleReplayBatch(
      [
        part(21, 'c1', 0, 3, 'ABC'),
        legacy(22, 'b'),
        part(23, 'c1', 1, 3, 'DEF'),
        part(24, 'c1', 2, 3, 'GHI'),
      ],
      opts(),
    );
    expect(second.lines).toEqual([
      { line: BIG, offset: 21 },
      { line: 'b', offset: 22 },
    ]);
    expect(second.resolveThrough).toBe('24');
    const all = [...first.lines, ...second.lines].map((l) => l.line);
    expect(all).toEqual(['a', BIG, 'b']); // each exactly once
  });

  it('writes a complete set that starts before the cut; its trailing part is a leftover on redelivery', () => {
    // set A: 10, 12 (complete); set B: 11, ... (incomplete)
    const r = reassembleReplayBatch(
      [
        part(10, 'A', 0, 2, 'AB'),
        part(11, 'B', 0, 2, 'XY'),
        part(12, 'A', 1, 2, 'CD'),
      ],
      opts(),
    );
    expect(r.lines).toEqual([{ line: 'ABCD', offset: 10 }]);
    expect(r.resolveThrough).toBe('10');
    expect(r.blockedAt).toBe('11');

    const again = reassembleReplayBatch(
      [
        part(11, 'B', 0, 2, 'XY'),
        part(12, 'A', 1, 2, 'CD'),
        part(13, 'B', 1, 2, 'ZW'),
      ],
      opts(),
    );
    expect(again.lines).toEqual([{ line: 'XYZW', offset: 11 }]);
    expect(again.leftoverParts).toBe(1);
    expect(again.dropped).toEqual([]);
    expect(again.resolveThrough).toBe('13');
  });

  it('ignores duplicate (redelivered / producer-retried) parts', () => {
    const r = reassembleReplayBatch(
      [
        part(1, 'c1', 0, 3, 'ABC'),
        part(2, 'c1', 0, 3, 'ABC'),
        part(3, 'c1', 1, 3, 'DEF'),
        part(4, 'c1', 1, 3, 'DEF'),
        part(5, 'c1', 2, 3, 'GHI'),
      ],
      opts(),
    );
    expect(r.lines).toEqual([{ line: BIG, offset: 1 }]);
    expect(r.reassembled).toBe(1);
    expect(r.resolveThrough).toBe('5');
  });

  it('skips leftover parts whose part 0 was resolved in an earlier batch', () => {
    const r = reassembleReplayBatch(
      [
        part(30, 'old', 1, 3, 'DEF'),
        part(31, 'old', 2, 3, 'GHI'),
        legacy(32, 'a'),
      ],
      opts(),
    );
    expect(r.lines).toEqual([{ line: 'a', offset: 32 }]);
    expect(r.leftoverParts).toBe(2);
    expect(r.dropped).toEqual([]);
    expect(r.resolveThrough).toBe('32');
  });

  it('drops sets with invalid headers and moves on', () => {
    const r = reassembleReplayBatch(
      [
        part(1, 'bad-count', 0, 99, 'x'), // count > maxParts
        part(2, 'one', 0, 1, 'x'), // count < 2
        part(3, 'idx', 3, 3, 'x'), // index >= count
        part(4, 'mix', 0, 3, 'x'),
        part(5, 'mix', 1, 4, 'y'), // counts disagree
        part(6, 'nan', 0, 2, 'x', T0, { 'x-replay-part': 'zero' }),
        legacy(7, 'ok'),
      ],
      opts(),
    );
    expect(r.lines).toEqual([{ line: 'ok', offset: 7 }]);
    expect(r.dropped.map((d) => [d.chunkId, d.reason])).toEqual([
      ['bad-count', 'invalid'],
      ['one', 'invalid'],
      ['idx', 'invalid'],
      ['mix', 'invalid'],
      ['nan', 'invalid'],
    ]);
    expect(r.blockedAt).toBeNull();
    expect(r.resolveThrough).toBe('7');
  });

  it('drops an incomplete set as abandoned once a later message is >= abandonAfterMs newer', () => {
    const r = reassembleReplayBatch(
      [
        part(1, 'orphan', 0, 3, 'ABC', T0),
        part(2, 'orphan', 1, 3, 'DEF', T0 + 1_000),
        legacy(3, 'a', T0 + 5_000),
        legacy(4, 'b', T0 + 120_000),
      ],
      opts(),
    );
    expect(r.lines.map((l) => l.line)).toEqual(['a', 'b']);
    expect(r.dropped).toEqual([
      {
        chunkId: 'orphan',
        reason: 'abandoned',
        firstOffset: '1',
        present: 2,
        declared: 3,
      },
    ]);
    expect(r.resolveThrough).toBe('4');
    expect(r.blockedAt).toBeNull();
  });

  it('keeps waiting while later messages are younger than abandonAfterMs', () => {
    const r = reassembleReplayBatch(
      [part(1, 'c1', 0, 3, 'ABC', T0), legacy(2, 'a', T0 + 119_999)],
      opts(),
    );
    expect(r.dropped).toEqual([]);
    expect(r.blockedAt).toBe('1');
  });

  it('drops a head set as unfetchable when the batch filled the partition fetch limit away from the tail', () => {
    const msgs = [part(1, 'c1', 0, 3, 'ABC'), legacy(2, 'x'.repeat(5000))];
    const blocked = reassembleReplayBatch(
      msgs,
      opts({
        atTail: false,
        maxBytesPerPartition: 1_000_000,
        maxMessageBytes: 1000,
      }),
    );
    expect(blocked.dropped).toEqual([]);
    expect(blocked.blockedAt).toBe('1');

    const full = reassembleReplayBatch(
      msgs,
      opts({
        atTail: false,
        maxBytesPerPartition: 6_000,
        maxMessageBytes: 1000,
      }),
    );
    expect(full.dropped.map((d) => d.reason)).toEqual(['unfetchable']);
    expect(full.lines.map((l) => l.offset)).toEqual([2]);
    expect(full.resolveThrough).toBe('2');
  });

  it('drops a head set blocked away from the tail for longer than maxHeadBlockedMs', () => {
    const msgs = [part(1, 'c1', 0, 3, 'ABC'), legacy(2, 'a')];
    expect(
      reassembleReplayBatch(
        msgs,
        opts({ atTail: false, headBlockedMs: 599_999 }),
      ).blockedAt,
    ).toBe('1');
    const r = reassembleReplayBatch(
      msgs,
      opts({ atTail: false, headBlockedMs: 600_000 }),
    );
    expect(r.dropped.map((d) => d.reason)).toEqual(['unfetchable']);
    expect(r.resolveThrough).toBe('2');
    // at the tail the same head just waits (the producer may still be sending)
    expect(
      reassembleReplayBatch(
        msgs,
        opts({ atTail: true, headBlockedMs: 600_000 }),
      ).blockedAt,
    ).toBe('1');
  });

  it('after an unfetchable head drop, cuts at the next incomplete set', () => {
    const r = reassembleReplayBatch(
      [
        part(1, 'c1', 0, 3, 'ABC'),
        legacy(2, 'a'),
        part(3, 'c2', 0, 2, 'XY'),
        legacy(4, 'b'),
      ],
      opts({ atTail: false, headBlockedMs: 600_000 }),
    );
    expect(r.dropped.map((d) => d.chunkId)).toEqual(['c1']);
    expect(r.lines.map((l) => l.line)).toEqual(['a']);
    expect(r.resolveThrough).toBe('2');
    expect(r.blockedAt).toBe('3');
  });

  it('does not report a broken set that lies past the cut (it is re-evaluated on redelivery)', () => {
    const r = reassembleReplayBatch(
      [part(1, 'wait', 0, 2, 'AB'), part(2, 'bad', 0, 99, 'x')],
      opts(),
    );
    expect(r.blockedAt).toBe('1');
    expect(r.dropped).toEqual([]);
  });

  it('records decode failures (legacy and joined) but still resolves past them', () => {
    const r = reassembleReplayBatch(
      [
        legacy(1, '!corrupt'),
        part(2, 'c1', 0, 2, '!x'),
        part(3, 'c1', 1, 2, 'y'),
        legacy(4, 'ok'),
      ],
      opts(),
    );
    expect(r.lines).toEqual([{ line: 'ok', offset: 4 }]);
    expect(r.decodeErrors.map((e) => e.offset)).toEqual(['1', '2']);
    expect(r.resolveThrough).toBe('4');
  });

  it('takes the first traceparent of an emitted message', () => {
    const m = legacy(1, 'a');
    m.headers!.traceparent = Buffer.from('00-abc-def-01');
    const r = reassembleReplayBatch([legacy(0, '!bad'), m], opts());
    expect(r.firstTraceparent).toBe('00-abc-def-01');
  });

  it('decodes a whole chunk with its own content-encoding and a joined set with part 0s', () => {
    const calls: [string, string | undefined][] = [];
    const spy = (v: Uint8Array, enc?: string) => {
      const line = Buffer.from(v).toString('utf8');
      calls.push([line, enc]);
      return line;
    };
    const noHeader = legacy(1, 'nohdr');
    noHeader.headers = {};
    const z = legacy(2, 'z');
    z.headers = { 'content-encoding': 'zstd' };
    const p0 = part(3, 'c1', 0, 2, 'AB', T0, { 'content-encoding': 'zstd' });
    const p1 = part(4, 'c1', 1, 2, 'CD', T0, { 'content-encoding': 'zstd' });
    reassembleReplayBatch(
      [noHeader, z, p0, p1, legacy(5, 'l')],
      opts({ decode: spy }),
    );
    expect(calls).toEqual([
      ['nohdr', undefined],
      ['z', 'zstd'],
      ['ABCD', 'zstd'],
      ['l', 'lz4'],
    ]);
  });

  it('decodes a mixed lz4 / zstd batch (with and without headers) with the real codecs', async () => {
    const { decodeReplayValue, encodeReplayLine } = await import(
      '@openpanel/queue/src/replay-kafka'
    );
    const { splitReplayValue } = await import(
      '@openpanel/queue/src/replay-parts'
    );
    const line = (i: number) =>
      JSON.stringify({
        project_id: 'p',
        session_id: `s${i}`,
        payload: 'x'.repeat(i * 1000),
      });
    const msg = (offset: number, value: Buffer, enc?: string) => ({
      offset: String(offset),
      timestamp: String(T0),
      value,
      headers: enc ? { 'content-encoding': enc } : {},
    });
    const big = JSON.stringify({
      payload: randomBytes(3_000).toString('base64'),
    });
    const zParts = splitReplayValue(encodeReplayLine(big, 'zstd'), 200);
    const r = reassembleReplayBatch(
      [
        msg(1, encodeReplayLine(line(1), 'lz4'), 'lz4'),
        msg(2, encodeReplayLine(line(2), 'zstd'), 'zstd'),
        msg(3, encodeReplayLine(line(3), 'lz4')), // no header: magic
        msg(4, encodeReplayLine(line(4), 'zstd')), // no header: magic
        ...zParts.map((v, i) => ({
          offset: String(10 + i),
          timestamp: String(T0),
          value: v,
          headers: {
            'content-encoding': 'zstd',
            'x-replay-chunk-id': 'z1',
            'x-replay-part': String(i),
            'x-replay-parts': String(zParts.length),
          },
        })),
      ],
      opts({ decode: decodeReplayValue }),
    );
    expect(zParts.length).toBeGreaterThan(1);
    expect(r.decodeErrors).toEqual([]);
    expect(r.lines.map((l) => l.line)).toEqual([
      line(1),
      line(2),
      line(3),
      line(4),
      big,
    ]);
    expect(r.reassembled).toBe(1);
  });

  it('handles an empty batch', () => {
    const r = reassembleReplayBatch([], opts());
    expect(r.lines).toEqual([]);
    expect(r.resolveThrough).toBeNull();
  });
});
