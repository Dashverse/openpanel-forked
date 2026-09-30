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

beforeEach(() => {
  sent.length = 0;
  sendMock.mockClear();
  connectMock.mockClear();
  vi.resetModules();
  vi.unstubAllEnvs();
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
    const line = JSON.stringify(
      makeChunk(`${rrwebPayload(1_000_000)}···né😀`),
    );
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

    expect(result).toBe('produced');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sent[0];
    expect(call.topic).toBe(KAFKA_REPLAY_TOPIC);
    const msg = call.messages[0];
    expect(msg.key).toBe('device_xyz');
    expect(msg.headers['content-encoding']).toBe('lz4');
    // the consumer will do exactly this — it must reconstruct JSON.stringify(chunk)
    expect(decompressReplayLine(msg.value)).toBe(JSON.stringify(chunk));
  });

  it('returns "oversize" and does NOT send when the compressed value exceeds the cap', async () => {
    vi.stubEnv('REPLAY_KAFKA_MAX_BYTES', '256');
    const { produceReplayChunk } = await import('./replay-kafka');
    const result = await produceReplayChunk(
      makeChunk(rrwebPayload(200_000)) as any,
      'device_xyz',
    );
    expect(result).toBe('oversize');
    expect(sendMock).not.toHaveBeenCalled();
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
