import { beforeEach, describe, expect, it, vi } from 'vitest';

const listeners: Record<string, (() => void)[]> = {};
let emit: ((event: any, isCheckout?: boolean) => void) | undefined;

vi.mock('rrweb', () => {
  const record: any = (opts: any) => {
    emit = opts.emit;
    return () => {};
  };
  record.takeFullSnapshot = () => {};
  return { record };
});

function addListener(type: string, fn: () => void) {
  const existing = listeners[type] ?? [];
  existing.push(fn);
  listeners[type] = existing;
}

beforeEach(() => {
  for (const key of Object.keys(listeners)) delete listeners[key];
  emit = undefined;
  (globalThis as any).document = {
    addEventListener: addListener,
    removeEventListener: () => {},
    visibilityState: 'visible',
  };
  (globalThis as any).window = {
    addEventListener: addListener,
    removeEventListener: () => {},
  };
});

/** A non-interactive incremental event of roughly `bytes` size. */
function event(bytes: number, timestamp: number) {
  return {
    type: 3,
    data: { source: 0, text: 'x'.repeat(bytes) },
    timestamp,
  };
}

function payloadBytes(payload: string) {
  return new TextEncoder().encode(payload).length;
}

describe('startReplayRecorder', () => {
  it('continues the chunk sequence from startChunkIndex', async () => {
    const { startReplayRecorder } = await import('./recorder');
    const indexes: number[] = [];

    startReplayRecorder(
      { flushIntervalMs: 1_000_000, maxEventsPerChunk: 1 },
      (chunk) => indexes.push(chunk.chunk_index),
      undefined,
      37,
    );
    emit!(event(10, 1));
    emit!(event(10, 2));

    expect(indexes).toEqual([37, 38]);
  });

  it('splits the unload flush into keepalive-sized bodies', async () => {
    const { startReplayRecorder } = await import('./recorder');
    const sizes: number[] = [];

    startReplayRecorder(
      { flushIntervalMs: 1_000_000, maxEventsPerChunk: 10_000 },
      (chunk) => sizes.push(payloadBytes(chunk.payload)),
      undefined,
    );
    for (let i = 0; i < 30; i++) emit!(event(10_000, i));

    (globalThis as any).document.visibilityState = 'hidden';
    for (const fn of listeners.visibilitychange ?? []) fn();

    expect(sizes.length).toBeGreaterThan(1);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(32 * 1024);
  });

  it('keeps the larger split threshold for the periodic flush', async () => {
    const { startReplayRecorder } = await import('./recorder');
    const sizes: number[] = [];

    startReplayRecorder(
      { flushIntervalMs: 1_000_000, maxEventsPerChunk: 30 },
      (chunk) => sizes.push(payloadBytes(chunk.payload)),
      undefined,
    );
    for (let i = 0; i < 30; i++) emit!(event(10_000, i));

    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toBeGreaterThan(32 * 1024);
  });
});
