import { describe, expect, it } from 'vitest';
import {
  compressReplayBlock,
  decompressReplayBlock,
  replayBlockBlobPath,
} from './replay-blocks';

// Pure block mechanics (no Azure): the zstd NDJSON round-trip that serving
// relies on, and the deterministic per-session blob path.
describe('compressReplayBlock / decompressReplayBlock', () => {
  it('round-trips NDJSON chunk lines byte-identically', () => {
    const lines = [
      JSON.stringify({ chunk_index: 0, payload: '[{"type":2,"data":{}}]' }),
      JSON.stringify({ chunk_index: 1, payload: '[{"type":3,"data":{"x":1}}]' }),
      // a line with escaped unicode + escaped newline inside the JSON string
      JSON.stringify({ chunk_index: 2, payload: 'né😀\nstill-one-line' }),
    ];
    const back = decompressReplayBlock(compressReplayBlock(lines));
    expect(back).toEqual(lines);
  });

  it('actually compresses a repetitive block', () => {
    const line = JSON.stringify({ payload: 'x'.repeat(5000) });
    const lines = Array.from({ length: 50 }, () => line);
    const raw = Buffer.byteLength(lines.join('\n'));
    expect(compressReplayBlock(lines).length).toBeLessThan(raw);
  });
});

describe('replayBlockBlobPath', () => {
  it('builds a dated, per-session path under the blocks prefix', () => {
    const p = replayBlockBlobPath('proj_1', 'sess_abc', '2026-10-01 12:00:00.000');
    expect(p).toBe('blocks/dt=2026-10-01/project=proj_1/session=sess_abc.zst');
  });

  it('url-encodes ids and tolerates a bad date', () => {
    const p = replayBlockBlobPath('a/b', 'c d', 'not-a-date');
    expect(p).toMatch(/^blocks\/dt=\d{4}-\d{2}-\d{2}\/project=a%2Fb\/session=c%20d\.zst$/);
  });
});
