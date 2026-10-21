import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We mock ONLY the Kafka client (no broker in unit tests). getKafka().producer()
// returns a fake whose send() we capture, so we can assert the exact wire bytes.
const sent: any[] = [];
const sendMock = vi.fn(async (payload: any) => {
  sent.push(payload);
});
const connectMock = vi.fn(async () => undefined);

vi.mock('./kafka', () => ({
  isKafkaConfigured: () => true,
  kafkaLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getKafka: () => ({
    producer: () => ({ connect: connectMock, send: sendMock }),
    consumer: () => ({}),
  }),
}));

// Telemetry's currentTraceparent is fine to run for real (returns undefined with
// no active span); mock it to keep the header assertion deterministic.
vi.mock('@openpanel/telemetry', () => ({
  currentTraceparent: () => undefined,
}));

const makeChunk = (payload: string) => ({
  project_id: 'proj_1',
  session_id: 'sess_abc',
  window_id: 'win_1',
  chunk_index: 3,
  started_at: '2026-09-30 10:00:00.000',
  ended_at: '2026-09-30 10:00:05.000',
  events_count: 42,
  is_full_snapshot: true,
  payload,
});

// Build a realistic-ish rrweb payload of roughly `targetBytes` that compresses
// like real replay JSON (repetitive structure, not random).
const rrwebPayload = (targetBytes: number): string => {
  const one = JSON.stringify({
    type: 3,
    timestamp: 1727690400000,
    data: {
      source: 2,
      texts: [],
      attributes: [{ id: 12, attributes: { class: 'x-node active hovered' } }],
      removes: [],
      adds: [{ parentId: 1, nextId: null, node: { id: 99, tagName: 'div' } }],
    },
  });
  const events: string[] = [];
  let size = 0;
  while (size < targetBytes) {
    events.push(one);
    size += one.length + 1;
  }
  return `[${events.join(',')}]`;
};

// Incompressible payload (random base64), so the LZ4 value is about as big as
// the input and a small REPLAY_KAFKA_MAX_BYTES forces a split.
const randomPayload = (bytes: number): string =>
  randomBytes(Math.ceil((bytes * 3) / 4)).toString('base64');

beforeEach(() => {
  vi.unstubAllEnvs();
  // splitting is opt-in (REPLAY_KAFKA_SPLIT_ENABLED); most tests cover it on
  vi.stubEnv('REPLAY_KAFKA_SPLIT_ENABLED', '1');
  sent.length = 0;
  sendMock.mockReset();
  sendMock.mockImplementation(async (payload: any) => {
    sent.push(payload);
  });
  connectMock.mockClear();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compressReplayLine / decompressReplayLine', () => {
  it('round-trips a small JSON line byte-identically', async () => {
    const { compressReplayLine, decompressReplayLine } = await import(
      './replay-kafka'
    );
    const line = JSON.stringify(makeChunk(rrwebPayload(2_000)));
    const back = decompressReplayLine(compressReplayLine(line));
    expect(back).toBe(line);
  });

  it('round-trips a ~1MB payload with unicode byte-identically', async () => {
    const { compressReplayLine, decompressReplayLine } = await import(
      './replay-kafka'
    );
    // include multibyte chars to prove the TextEncoder/TextDecoder path is safe
    const line = JSON.stringify(makeChunk(`${rrwebPayload(1_000_000)}···né😀`));
    const value = compressReplayLine(line);
    // real rrweb JSON compresses well — sanity check it actually shrank
    expect(value.length).toBeLessThan(Buffer.byteLength(line, 'utf8'));
    expect(decompressReplayLine(value)).toBe(line);
  });
});

describe('produceReplayChunk', () => {
  it('produces the LZ4 wire value keyed by deviceId, round-trippable to the exact line', async () => {
    const { produceReplayChunk, decompressReplayLine, KAFKA_REPLAY_TOPIC } =
      await import('./replay-kafka');
    const chunk = makeChunk(rrwebPayload(50_000));
    const result = await produceReplayChunk(chunk as any, 'device_xyz');

    expect(result.status).toBe('produced');
    expect(result.parts).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sent[0];
    expect(call.topic).toBe(KAFKA_REPLAY_TOPIC);
    const msg = call.messages[0];
    expect(msg.key).toBe('device_xyz');
    expect(msg.headers['content-encoding']).toBe('lz4');
    // under the limit: exactly the legacy wire format, no part headers
    expect(msg.headers['x-replay-chunk-id']).toBeUndefined();
    expect(msg.headers['x-replay-part']).toBeUndefined();
    // the consumer will do exactly this — it must reconstruct JSON.stringify(chunk)
    expect(decompressReplayLine(msg.value)).toBe(JSON.stringify(chunk));
  });

  it('returns "oversize" and does NOT send when the compressed value exceeds the total cap', async () => {
    vi.stubEnv('REPLAY_KAFKA_MAX_BYTES', '256');
    vi.stubEnv('REPLAY_KAFKA_MAX_TOTAL_BYTES', '2000');
    const { produceReplayChunk } = await import('./replay-kafka');
    const result = await produceReplayChunk(
      makeChunk(randomPayload(20_000)) as any,
      'device_xyz',
    );
    expect(result.status).toBe('oversize');
    expect(result.compressedBytes).toBeGreaterThan(2000);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns "oversize" for an over-limit chunk when splitting is disabled (the default)', async () => {
    vi.stubEnv('REPLAY_KAFKA_SPLIT_ENABLED', '');
    vi.stubEnv('REPLAY_KAFKA_MAX_BYTES', '4000');
    const { produceReplayChunk } = await import('./replay-kafka');
    const result = await produceReplayChunk(
      makeChunk(randomPayload(15_000)) as any,
      'sess_abc',
    );
    expect(result.status).toBe('oversize');
    expect(sendMock).not.toHaveBeenCalled();
    // under the limit it still produces normally
    const small = await produceReplayChunk(
      makeChunk(rrwebPayload(1_000)) as any,
      'sess_abc',
    );
    expect(small.status).toBe('produced');
  });

  it('returns "oversize" when the split would need more parts than REPLAY_KAFKA_MAX_PARTS', async () => {
    vi.stubEnv('REPLAY_KAFKA_MAX_BYTES', '1000');
    vi.stubEnv('REPLAY_KAFKA_MAX_PARTS', '4');
    const { produceReplayChunk } = await import('./replay-kafka');
    const result = await produceReplayChunk(
      makeChunk(randomPayload(20_000)) as any,
      'device_xyz',
    );
    expect(result.status).toBe('oversize');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('splits a value over the per-message limit into ordered parts, one send each, same key', async () => {
    vi.stubEnv('REPLAY_KAFKA_MAX_BYTES', '4000');
    const { produceReplayChunk, decompressReplayLine } = await import(
      './replay-kafka'
    );
    const { joinReplayParts } = await import('./replay-parts');
    const chunk = makeChunk(randomPayload(15_000));
    const result = await produceReplayChunk(chunk as any, 'sess_abc');

    expect(result.status).toBe('produced');
    const n = Math.ceil(result.compressedBytes / 4000);
    expect(n).toBeGreaterThan(1);
    expect(result.parts).toBe(n);
    // one Produce request per part (Event Hubs' 1 MB cap is per request too)
    expect(sendMock).toHaveBeenCalledTimes(n);
    const msgs = sent.map((call) => {
      expect(call.messages).toHaveLength(1);
      return call.messages[0];
    });
    const chunkId = msgs[0].headers['x-replay-chunk-id'];
    expect(chunkId).toMatch(/^[0-9a-f-]{36}$/);
    msgs.forEach((m: any, i: number) => {
      expect(m.key).toBe('sess_abc');
      expect(m.value.length).toBeLessThanOrEqual(4000);
      expect(m.headers['content-encoding']).toBe('lz4');
      expect(m.headers['x-replay-chunk-id']).toBe(chunkId);
      expect(m.headers['x-replay-part']).toBe(String(i));
      expect(m.headers['x-replay-parts']).toBe(String(n));
    });
    const joined = joinReplayParts(msgs.map((m: any) => m.value));
    expect(joined.length).toBe(result.compressedBytes);
    expect(decompressReplayLine(joined)).toBe(JSON.stringify(chunk));
  });

  it('awaits each part before sending the next, and a failed part throws with no further parts', async () => {
    vi.stubEnv('REPLAY_KAFKA_MAX_BYTES', '4000');
    let active = 0;
    let maxActive = 0;
    sendMock.mockImplementation(async (payload: any) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      sent.push(payload);
      if (sent.length === 2) throw new Error('broker down');
    });
    const { produceReplayChunk } = await import('./replay-kafka');
    await expect(
      produceReplayChunk(makeChunk(randomPayload(15_000)) as any, 'sess_abc'),
    ).rejects.toThrow('broker down');
    expect(maxActive).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('gives each produce attempt of a split chunk a new chunk id', async () => {
    vi.stubEnv('REPLAY_KAFKA_MAX_BYTES', '4000');
    const { produceReplayChunk } = await import('./replay-kafka');
    const chunk = makeChunk(randomPayload(15_000)) as any;
    await produceReplayChunk(chunk, 'sess_abc');
    const first = sent[0].messages[0].headers['x-replay-chunk-id'];
    sent.length = 0;
    await produceReplayChunk(chunk, 'sess_abc');
    expect(sent[0].messages[0].headers['x-replay-chunk-id']).not.toBe(first);
  });

  it('rejects a split chunk with backpressure when in-flight part bytes would exceed the cap', async () => {
    vi.stubEnv('REPLAY_KAFKA_MAX_BYTES', '4000');
    vi.stubEnv('REPLAY_KAFKA_MAX_INFLIGHT_PART_BYTES', '25000');
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    sendMock.mockImplementation(async () => {
      await held;
    });
    const { produceReplayChunk } = await import('./replay-kafka');
    const p1 = produceReplayChunk(
      makeChunk(randomPayload(15_000)) as any,
      'sess_a',
    );
    await new Promise((r) => setTimeout(r, 0));
    await expect(
      produceReplayChunk(makeChunk(randomPayload(15_000)) as any, 'sess_b'),
    ).rejects.toThrow(/backpressure/);
    release();
    await p1;
  });

  it('throws when the producer send fails (so /track errors → SDK retry)', async () => {
    sendMock.mockRejectedValueOnce(new Error('broker down'));
    const { produceReplayChunk } = await import('./replay-kafka');
    await expect(
      produceReplayChunk(makeChunk(rrwebPayload(1_000)) as any, 'device_xyz'),
    ).rejects.toThrow('broker down');
  });

  it('rejects with backpressure once in-flight produces reach the cap', async () => {
    vi.stubEnv('REPLAY_KAFKA_MAX_CONCURRENT_PRODUCES', '2');
    // Hold every send open so the in-flight counter stays at the cap.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    sendMock.mockImplementation(async () => {
      await held;
    });
    const { produceReplayChunk } = await import('./replay-kafka');
    const chunk = () => makeChunk(rrwebPayload(1_000)) as any;

    // Two in-flight sends occupy the cap (they never resolve until released).
    const p1 = produceReplayChunk(chunk(), 'device_xyz');
    const p2 = produceReplayChunk(chunk(), 'device_xyz');
    await new Promise((r) => setTimeout(r, 0)); // let both enter the send await

    // The third is rejected immediately, before it ever calls send.
    await expect(produceReplayChunk(chunk(), 'device_xyz')).rejects.toThrow(
      /backpressure/,
    );
    expect(sendMock).toHaveBeenCalledTimes(2);

    // Release and let the two in-flight ones finish so nothing dangles.
    release();
    await Promise.all([p1, p2]);
  });
});

describe('split cap derived from the consumer fetch size', () => {
  it('defaults to the 5 MiB fetch minus two max-size messages', async () => {
    const q = await import('./replay-kafka');
    expect(q.REPLAY_KAFKA_MAX_BYTES_PER_PARTITION).toBe(5 * 1024 * 1024);
    expect(q.REPLAY_KAFKA_MAX_TOTAL_BYTES).toBe(5 * 1024 * 1024 - 2 * 950_000);
  });

  it('follows KAFKA_REPLAY_MAX_BYTES_PER_PARTITION', async () => {
    vi.stubEnv('KAFKA_REPLAY_MAX_BYTES_PER_PARTITION', '100000');
    vi.stubEnv('REPLAY_KAFKA_MAX_BYTES', '10000');
    const q = await import('./replay-kafka');
    expect(q.REPLAY_KAFKA_MAX_TOTAL_BYTES).toBe(80_000);
  });

  it('clamps a REPLAY_KAFKA_MAX_TOTAL_BYTES above the fetch size, with a warning', async () => {
    vi.stubEnv('KAFKA_REPLAY_MAX_BYTES_PER_PARTITION', '100000');
    vi.stubEnv('REPLAY_KAFKA_MAX_BYTES', '10000');
    vi.stubEnv('REPLAY_KAFKA_MAX_TOTAL_BYTES', '10000000');
    const { kafkaLogger } = await import('./kafka');
    const q = await import('./replay-kafka');
    expect(q.REPLAY_KAFKA_MAX_TOTAL_BYTES).toBe(80_000);
    expect(kafkaLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('clamped'),
      expect.objectContaining({ requested: 10_000_000, clampedTo: 80_000 }),
    );
  });

  it('keeps a REPLAY_KAFKA_MAX_TOTAL_BYTES below the fetch size as is', async () => {
    vi.stubEnv('REPLAY_KAFKA_MAX_TOTAL_BYTES', '2000000');
    const q = await import('./replay-kafka');
    expect(q.REPLAY_KAFKA_MAX_TOTAL_BYTES).toBe(2_000_000);
  });

  it('a chunk over the derived cap is oversize', async () => {
    vi.stubEnv('KAFKA_REPLAY_MAX_BYTES_PER_PARTITION', '30000');
    vi.stubEnv('REPLAY_KAFKA_MAX_BYTES', '4000');
    const { produceReplayChunk } = await import('./replay-kafka');
    const ok = await produceReplayChunk(
      makeChunk(randomPayload(15_000)) as any,
      'sess_abc',
    );
    expect(ok.status).toBe('produced');
    const big = await produceReplayChunk(
      makeChunk(randomPayload(30_000)) as any,
      'sess_abc',
    );
    expect(big.status).toBe('oversize');
  });
});

describe('codec (REPLAY_KAFKA_CODEC)', () => {
  const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
  const LZ4_MAGIC = [0x04, 0x22, 0x4d, 0x18];

  it('defaults to lz4 with content-encoding lz4', async () => {
    const { produceReplayChunk } = await import('./replay-kafka');
    await produceReplayChunk(makeChunk(rrwebPayload(5_000)) as any, 'k');
    const msg = sent[0].messages[0];
    expect(msg.headers['content-encoding']).toBe('lz4');
    expect([...msg.value.subarray(0, 4)]).toEqual(LZ4_MAGIC);
  });

  it('zstd: produces a zstd frame with content-encoding zstd that round-trips', async () => {
    vi.stubEnv('REPLAY_KAFKA_CODEC', 'zstd');
    const { produceReplayChunk, decodeReplayValue } = await import(
      './replay-kafka'
    );
    const chunk = makeChunk(`${rrwebPayload(50_000)}···né😀`);
    const r = await produceReplayChunk(chunk as any, 'k');
    const msg = sent[0].messages[0];
    expect(r.status).toBe('produced');
    expect(msg.headers['content-encoding']).toBe('zstd');
    expect([...msg.value.subarray(0, 4)]).toEqual(ZSTD_MAGIC);
    expect(decodeReplayValue(msg.value, 'zstd')).toBe(JSON.stringify(chunk));
  });

  it('zstd: size checks and splitting apply to the zstd bytes', async () => {
    vi.stubEnv('REPLAY_KAFKA_CODEC', 'zstd');
    vi.stubEnv('REPLAY_KAFKA_MAX_BYTES', '4000');
    const { produceReplayChunk, decodeReplayValue, encodeReplayLine } =
      await import('./replay-kafka');
    const { joinReplayParts } = await import('./replay-parts');
    const chunk = makeChunk(randomPayload(15_000));
    const r = await produceReplayChunk(chunk as any, 'sess_abc');
    expect(r.compressedBytes).toBe(
      encodeReplayLine(JSON.stringify(chunk), 'zstd').length,
    );
    expect(r.parts).toBe(Math.ceil(r.compressedBytes / 4000));
    const msgs = sent.map((c) => c.messages[0]);
    for (const m of msgs) {
      expect(m.headers['content-encoding']).toBe('zstd');
    }
    const joined = joinReplayParts(msgs.map((m: any) => m.value));
    expect(decodeReplayValue(joined, 'zstd')).toBe(JSON.stringify(chunk));
  });

  it('falls back to lz4 (with a warning) for an unknown codec', async () => {
    vi.stubEnv('REPLAY_KAFKA_CODEC', 'brotli');
    const { kafkaLogger } = await import('./kafka');
    const { produceReplayChunk } = await import('./replay-kafka');
    await produceReplayChunk(makeChunk(rrwebPayload(1_000)) as any, 'k');
    expect(sent[0].messages[0].headers['content-encoding']).toBe('lz4');
    expect(kafkaLogger.warn).toHaveBeenCalledWith(
      'Unsupported REPLAY_KAFKA_CODEC; using lz4',
      { value: 'brotli' },
    );
  });

  it('decodeReplayValue: by header, by magic when the header is missing, both codecs', async () => {
    const { decodeReplayValue, encodeReplayLine } = await import(
      './replay-kafka'
    );
    const line = JSON.stringify(makeChunk(rrwebPayload(20_000)));
    const lz = encodeReplayLine(line, 'lz4');
    const zs = encodeReplayLine(line, 'zstd');
    expect(decodeReplayValue(lz, 'lz4')).toBe(line);
    expect(decodeReplayValue(zs, 'zstd')).toBe(line);
    expect(decodeReplayValue(lz)).toBe(line);
    expect(decodeReplayValue(zs)).toBe(line);
    expect(decodeReplayValue(zs, ' ZSTD ')).toBe(line);
    // unknown header value: magic decides
    expect(decodeReplayValue(zs, 'x-unknown')).toBe(line);
    expect(() => decodeReplayValue(Buffer.from('not compressed'))).toThrow(
      /unknown replay content-encoding/,
    );
  });

  it('detectReplayCodec reads the frame magic', async () => {
    const { detectReplayCodec } = await import('./replay-kafka');
    expect(detectReplayCodec(Buffer.from(ZSTD_MAGIC))).toBe('zstd');
    expect(detectReplayCodec(Buffer.from(LZ4_MAGIC))).toBe('lz4');
    expect(detectReplayCodec(Buffer.from([1, 2]))).toBeNull();
  });
});

describe('shouldUseReplayKafka (env-gated rollout flag)', () => {
  it('is false for every project when the allow-list is empty', async () => {
    vi.stubEnv('REPLAY_KAFKA_PROJECT_IDS', '');
    const { shouldUseReplayKafka } = await import('./replay-kafka');
    expect(shouldUseReplayKafka('proj_1')).toBe(false);
  });

  it('matches only listed project ids', async () => {
    vi.stubEnv('REPLAY_KAFKA_PROJECT_IDS', 'proj_1, proj_2');
    const { shouldUseReplayKafka } = await import('./replay-kafka');
    expect(shouldUseReplayKafka('proj_1')).toBe(true);
    expect(shouldUseReplayKafka('proj_2')).toBe(true);
    expect(shouldUseReplayKafka('proj_3')).toBe(false);
  });

  it('matches all projects with "*"', async () => {
    vi.stubEnv('REPLAY_KAFKA_PROJECT_IDS', '*');
    const { shouldUseReplayKafka } = await import('./replay-kafka');
    expect(shouldUseReplayKafka('anything')).toBe(true);
  });
});
