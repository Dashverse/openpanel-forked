import { describe, expect, it } from 'vitest';
import {
  ReplayFramesError,
  decodeReplayFrames,
  encodeReplayFramePrefix,
  encodeReplayFrames,
  encodeReplayFramesHeader,
  encodeReplayFramesTerminator,
} from './replay-frames';

const bytes = (...n: number[]) => new Uint8Array(n);

describe('replay frames', () => {
  it('round trips frames (including empty data and unicode keys)', () => {
    const frames = [
      { key: '123.0', data: bytes(1, 2, 3) },
      { key: 'c1760140800000.0', data: bytes() },
      { key: 'kéy', data: new Uint8Array(70_000).fill(7) },
    ];
    const out = decodeReplayFrames(encodeReplayFrames(frames));
    expect(out.map((f) => f.key)).toEqual(frames.map((f) => f.key));
    expect(out.map((f) => Array.from(f.data))).toEqual(
      frames.map((f) => Array.from(f.data)),
    );
  });

  it('streamed pieces (header, prefix + data, terminator) equal the one-shot encoding', () => {
    const data = bytes(9, 8, 7);
    const parts = [
      encodeReplayFramesHeader(),
      encodeReplayFramePrefix('a', data.length),
      data,
      encodeReplayFramesTerminator(),
    ];
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      joined.set(p, at);
      at += p.length;
    }
    expect(Array.from(joined)).toEqual(
      Array.from(encodeReplayFrames([{ key: 'a', data }])),
    );
  });

  it('an empty response is just header + terminator', () => {
    expect(decodeReplayFrames(encodeReplayFrames([]))).toEqual([]);
  });

  it('detects truncation, bad magic and bad version', () => {
    const full = encodeReplayFrames([{ key: 'a', data: bytes(1, 2, 3, 4) }]);
    // cut anywhere before the terminator ends -> error, never a partial result
    for (let cut = 0; cut < full.length; cut++) {
      expect(() => decodeReplayFrames(full.subarray(0, cut))).toThrow(
        ReplayFramesError,
      );
    }
    const badMagic = Uint8Array.from(full);
    badMagic[0] = 0;
    expect(() => decodeReplayFrames(badMagic)).toThrow('bad magic');
    const badVersion = Uint8Array.from(full);
    badVersion[4] = 9;
    expect(() => decodeReplayFrames(badVersion)).toThrow('version');
  });

  it('decodes from a view into a larger buffer (byteOffset != 0)', () => {
    const enc = encodeReplayFrames([{ key: 'x', data: bytes(5) }]);
    const big = new Uint8Array(enc.length + 10);
    big.set(enc, 10);
    const out = decodeReplayFrames(big.subarray(10));
    expect(out[0]!.key).toBe('x');
    expect(Array.from(out[0]!.data)).toEqual([5]);
  });

  it('rejects an empty key on encode', () => {
    expect(() => encodeReplayFramePrefix('', 1)).toThrow();
  });
});
