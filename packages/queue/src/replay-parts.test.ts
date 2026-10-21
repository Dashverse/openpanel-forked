import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compressReplayLine, decompressReplayLine } from './replay-kafka';
import { joinReplayParts, splitReplayValue } from './replay-parts';

describe('splitReplayValue / joinReplayParts', () => {
  it('splits into slices of at most the part size and joins byte-identically', () => {
    const value = randomBytes(10_001);
    const parts = splitReplayValue(value, 2500);
    expect(parts.map((p) => p.length)).toEqual([2500, 2500, 2500, 2500, 1]);
    expect(joinReplayParts(parts).equals(value)).toBe(true);
  });

  it('returns one part when the value fits', () => {
    const value = randomBytes(100);
    const parts = splitReplayValue(value, 100);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.equals(value)).toBe(true);
  });

  it('round-trips a real LZ4 replay value through split + join + decompress', () => {
    const line = JSON.stringify({
      project_id: 'p',
      session_id: 's',
      payload: `${randomBytes(300_000).toString('base64')}·né😀`,
    });
    const value = compressReplayLine(line);
    const parts = splitReplayValue(value, 64_000);
    expect(parts.length).toBeGreaterThan(1);
    expect(decompressReplayLine(joinReplayParts(parts))).toBe(line);
  });

  it('accepts a plain Uint8Array and rejects a non-positive part size', () => {
    const u8 = new Uint8Array([1, 2, 3, 4, 5]);
    expect(joinReplayParts(splitReplayValue(u8, 2))).toEqual(Buffer.from(u8));
    expect(() => splitReplayValue(u8, 0)).toThrow();
  });
});
