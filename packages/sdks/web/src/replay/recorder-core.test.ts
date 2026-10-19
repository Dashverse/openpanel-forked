import type { eventWithTime } from 'rrweb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ReplayChunkPayload,
  type ReplayCoreOptions,
  ReplayRecorderCore,
} from './recorder-core';
import { PLACEHOLDER_IMAGE_DATA_URI, utf8ByteLength } from './size-utils';

const MIN = 60_000;

const ev = (type: number, data: unknown): eventWithTime =>
  ({ type, data, timestamp: Date.now() }) as eventWithTime;
const meta = () => ev(4, { href: 'https://x.test/', width: 1280, height: 720 });
const fullSnapshot = (pad = '') =>
  ev(2, { node: { id: 1, pad }, initialOffset: { top: 0, left: 0 } });
const mouseMove = () => ev(3, { source: 1, positions: [] });
const click = () => ev(3, { source: 2, type: 2, id: 5 });
const canvas = () => ev(3, { source: 9, id: 7, type: 0, commands: [] });
const mutation = (pad = '') =>
  ev(3, {
    source: 0,
    texts: [{ id: 1, value: pad }],
    attributes: [],
    removes: [],
    adds: [],
  });

function setup(options: ReplayCoreOptions = {}) {
  const chunks: ReplayChunkPayload[] = [];
  const onUserActivity = vi.fn();
  let snapshots = 0;
  const core: ReplayRecorderCore = new ReplayRecorderCore(options, {
    sendChunk: (chunk) => chunks.push(chunk),
    // Like rrweb: takeFullSnapshot emits Meta + FullSnapshot synchronously.
    takeFullSnapshot: () => {
      snapshots += 1;
      core.handleEvent(meta());
      core.handleEvent(fullSnapshot());
    },
    onUserActivity,
  });
  core.start();
  // rrweb's record() takes the initial snapshot itself.
  core.handleEvent(meta());
  core.handleEvent(fullSnapshot());
  return {
    core,
    chunks,
    onUserActivity,
    snapshots: () => snapshots,
    events: () =>
      chunks.flatMap((c) => JSON.parse(c.payload) as eventWithTime[]),
  };
}

/** Advance `totalMs` in `stepMs` steps, emitting `make()` after each step. */
function every(
  core: ReplayRecorderCore,
  stepMs: number,
  totalMs: number,
  make: () => eventWithTime,
) {
  for (let t = stepMs; t <= totalMs; t += stepMs) {
    vi.advanceTimersByTime(stepMs);
    core.handleEvent(make());
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-19T10:00:00.000Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('full snapshot scheduling', () => {
  it('takes one every 5 min while the user is active, not every flush', () => {
    const r = setup();
    every(r.core, MIN, 15 * MIN, mouseMove);
    expect(r.snapshots()).toBe(3);

    r.core.flush();
    const fullChunks = r.chunks.filter((c) => c.is_full_snapshot);
    // initial + 3 periodic, despite a flush every 10 s
    expect(fullChunks).toHaveLength(4);
    expect(r.chunks.length).toBeGreaterThan(fullChunks.length);
  });

  it('honours a custom interval, and 0 disables periodic snapshots', () => {
    const fast = setup({ fullSnapshotIntervalMs: MIN });
    every(fast.core, 30_000, 4 * MIN, mouseMove);
    expect(fast.snapshots()).toBe(4);
    fast.core.stop();

    const off = setup({ fullSnapshotIntervalMs: 0 });
    every(off.core, 30_000, 20 * MIN, mouseMove);
    expect(off.snapshots()).toBe(0);
  });

  it('takes none while idle, but still records every event', () => {
    const r = setup();
    // A video rendering / an answer streaming: changes, no input.
    let n = 0;
    every(r.core, 10_000, 30 * MIN, () =>
      n++ % 2 === 0 ? mutation(`frame ${n}`) : canvas(),
    );
    expect(r.snapshots()).toBe(0);
    expect(r.core.idle).toBe(true);

    vi.advanceTimersByTime(10_000); // flush timer
    const sent = r.events();
    expect(sent).toHaveLength(2 + n); // initial Meta + FullSnapshot + all
    expect(sent.filter((e) => e.type === 2)).toHaveLength(1);
    const last = Math.max(...sent.map((e) => e.timestamp));
    expect(last - Date.parse('2026-10-19T10:00:00.000Z')).toBe(30 * MIN);
  });

  it('takes none on a static page with no events at all', () => {
    const r = setup();
    vi.advanceTimersByTime(60 * MIN);
    expect(r.snapshots()).toBe(0);
    expect(r.core.idle).toBe(true);
  });

  it('takes one immediately on the first activity after idle, then restarts the clock', () => {
    const r = setup();
    every(r.core, 30_000, 20 * MIN, () => mutation('tick'));
    expect(r.core.idle).toBe(true);
    r.onUserActivity.mockClear();

    r.core.handleEvent(click());
    expect(r.snapshots()).toBe(1);
    expect(r.core.idle).toBe(false);
    expect(r.onUserActivity).toHaveBeenCalledTimes(1);

    r.core.flush();
    const wake = r.chunks[r.chunks.length - 1]!;
    expect(wake.is_full_snapshot).toBe(true);
    expect(JSON.parse(wake.payload).map((e: eventWithTime) => e.type)).toEqual([
      4, 2, 3,
    ]);

    // Periodic snapshots resume, one interval after the wake-up snapshot.
    every(r.core, MIN, 4 * MIN, mouseMove);
    expect(r.snapshots()).toBe(1);
    every(r.core, MIN, MIN, mouseMove);
    expect(r.snapshots()).toBe(2);
  });

  it('takes one on wake after a long idle stretch even on a static page', () => {
    const r = setup();
    vi.advanceTimersByTime(20 * MIN);
    expect(r.core.idle).toBe(true);
    r.core.handleEvent(click());
    expect(r.core.idle).toBe(false);
    expect(r.snapshots()).toBe(1);
  });

  it('does not snapshot on wake soon after the last snapshot, just restarts the clock', () => {
    const r = setup({ idleThresholdMs: MIN });
    vi.advanceTimersByTime(90_000);
    r.core.handleEvent(mutation('bg'));
    expect(r.core.idle).toBe(true);

    vi.advanceTimersByTime(30_000);
    r.core.handleEvent(click()); // 2 min after the initial snapshot
    expect(r.core.idle).toBe(false);
    expect(r.snapshots()).toBe(0);

    // Clock restarted at the wake: next snapshot 5 min after it.
    every(r.core, 30_000, 4.5 * MIN, mouseMove);
    expect(r.snapshots()).toBe(0);
    every(r.core, 30_000, 30_000, mouseMove);
    expect(r.snapshots()).toBe(1);
  });

  it('takes one when the tab becomes visible again after going idle while hidden', () => {
    const r = setup();
    r.core.handleEvent(mouseMove());
    r.core.handleVisibilityChange(false);
    const flushedOnHide = r.chunks.length;
    expect(flushedOnHide).toBeGreaterThan(0);

    every(r.core, 30_000, 20 * MIN, () => mutation('bg'));
    expect(r.core.idle).toBe(true);
    r.onUserActivity.mockClear();

    r.core.handleVisibilityChange(true);
    expect(r.snapshots()).toBe(1);
    expect(r.core.idle).toBe(false);
    expect(r.onUserActivity).toHaveBeenCalledTimes(1);
  });

  it('does not snapshot on a quick tab switch while active', () => {
    const r = setup();
    r.core.handleEvent(mouseMove());
    r.core.handleVisibilityChange(false);
    vi.advanceTimersByTime(30_000);
    r.core.handleVisibilityChange(true);
    expect(r.snapshots()).toBe(0);
    expect(r.onUserActivity).toHaveBeenCalledTimes(1); // the mouse move only
  });

  it('stops cleanly when the activity bump restarts the recorder (session rotation)', () => {
    const chunks: ReplayChunkPayload[] = [];
    const takeFullSnapshot = vi.fn();
    // The SDK's rotation handler stops this recorder from inside the bump.
    const onUserActivity = vi.fn(() => core.stop());
    const core: ReplayRecorderCore = new ReplayRecorderCore(
      {},
      { sendChunk: (c) => chunks.push(c), takeFullSnapshot, onUserActivity },
    );
    core.start();
    core.handleEvent(meta());
    core.handleEvent(fullSnapshot());
    every(core, 30_000, 20 * MIN, () => mutation('bg'));
    onUserActivity.mockClear();
    vi.advanceTimersByTime(5000);

    core.handleEvent(click());
    expect(onUserActivity).toHaveBeenCalledTimes(1);
    expect(core.isStopped).toBe(true);
    // The new recorder takes its own initial snapshot; the old one must not.
    expect(takeFullSnapshot).not.toHaveBeenCalled();
    const sent = chunks.flatMap(
      (c) => JSON.parse(c.payload) as eventWithTime[],
    );
    expect(sent.some((e) => e.type === 3 && (e.data as any).source === 2)).toBe(
      false,
    );
  });
});

describe('chunking', () => {
  it('flushes before an event would push the chunk past maxPayloadBytes', () => {
    const r = setup({ maxPayloadBytes: 1000, startChunkIndex: 7 });
    const sizes: number[] = [];
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(10);
      const e = mutation('x'.repeat(50 + ((i * 37) % 200)));
      sizes.push(utf8ByteLength(JSON.stringify(e)));
      r.core.handleEvent(i % 5 === 0 ? mouseMove() : e);
    }
    r.core.flush();

    expect(r.chunks.map((c) => c.chunk_index)).toEqual(
      r.chunks.map((_, i) => 7 + i),
    );
    for (const [i, c] of r.chunks.entries()) {
      const parsed = JSON.parse(c.payload) as eventWithTime[];
      expect(c.events_count).toBe(parsed.length);
      expect(utf8ByteLength(c.payload)).toBeLessThanOrEqual(1000);
      expect(c.started_at).toBe(
        new Date(Math.min(...parsed.map((e) => e.timestamp))).toISOString(),
      );
      expect(c.ended_at).toBe(
        new Date(Math.max(...parsed.map((e) => e.timestamp))).toISOString(),
      );
      // Tight: the next chunk's first event would not have fitted.
      const next = r.chunks[i + 1];
      if (next && !next.is_full_snapshot) {
        const firstNext = JSON.stringify(JSON.parse(next.payload)[0]);
        expect(
          utf8ByteLength(c.payload) + 1 + utf8ByteLength(firstNext),
        ).toBeGreaterThan(1000);
      }
    }
    expect(r.events()).toHaveLength(42); // initial Meta + FullSnapshot + 40
  });

  it('sends a single event over the cap alone and immediately', () => {
    const r = setup({ maxPayloadBytes: 1000 });
    r.core.handleEvent(mouseMove());
    const before = r.chunks.length;
    r.core.handleEvent(mutation('y'.repeat(5000)));
    // previous buffer + the big event, without waiting for the flush timer
    expect(r.chunks.length).toBe(before + 2);
    const big = r.chunks[r.chunks.length - 1]!;
    expect(big.events_count).toBe(1);
    expect(utf8ByteLength(big.payload)).toBeGreaterThan(1000);
  });

  it('flushes at maxEventsPerChunk', () => {
    const r = setup({ maxEventsPerChunk: 5 });
    for (let i = 0; i < 12; i++) r.core.handleEvent(mouseMove());
    r.core.flush();
    expect(r.chunks.map((c) => c.events_count)).toEqual([5, 5, 4]); // initial Meta + FullSnapshot + 12;
  });

  it('flags is_full_snapshot only for chunks holding a FullSnapshot, which always starts with Meta', () => {
    const r = setup({ maxPayloadBytes: 1000 });
    r.core.handleEvent(mouseMove());
    r.core.handleEvent(mutation('a'));
    // A periodic snapshot whose FullSnapshot alone is over the cap.
    r.core.handleEvent(meta());
    r.core.handleEvent(fullSnapshot('z'.repeat(3000)));
    r.core.handleEvent(mouseMove());
    r.core.flush();

    const types = r.chunks.map((c) =>
      (JSON.parse(c.payload) as eventWithTime[]).map((e) => e.type),
    );
    expect(types).toEqual([[4, 2, 3, 3], [4, 2], [3]]);
    expect(r.chunks.map((c) => c.is_full_snapshot)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('keeps payload identical to JSON.stringify(events) for normal events', () => {
    const chunks: ReplayChunkPayload[] = [];
    const core = new ReplayRecorderCore(
      {},
      { sendChunk: (c) => chunks.push(c), takeFullSnapshot: () => {} },
    );
    const events = [
      meta(),
      fullSnapshot('café 😀'),
      mouseMove(),
      mutation('data:image/png;base64,AAAA'),
    ];
    for (const e of events) core.handleEvent(e);
    core.flush();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.payload).toBe(JSON.stringify(events));
    expect(chunks[0]!.is_full_snapshot).toBe(true);
  });

  it('never sends a chunk twice when sendChunk re-enters flush (rotation during send)', () => {
    const chunks: ReplayChunkPayload[] = [];
    const core: ReplayRecorderCore = new ReplayRecorderCore(
      {},
      {
        sendChunk: (c) => {
          chunks.push(c);
          core.stop();
        },
        takeFullSnapshot: () => {},
      },
    );
    core.handleEvent(meta());
    core.handleEvent(fullSnapshot());
    core.handleEvent(mouseMove());
    core.flush();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.events_count).toBe(3);
  });
});

describe('oversized event safety net', () => {
  const imageUri = (n: number) => `data:image/png;base64,${'Q'.repeat(n)}`;

  it('leaves data URIs alone below maxEventBytes', () => {
    const r = setup({ maxEventBytes: 20_000, maxPayloadBytes: 100_000 });
    const e = ev(3, {
      source: 0,
      attributes: [{ id: 2, attributes: { src: imageUri(10_000) } }],
    });
    r.core.handleEvent(e);
    r.core.flush();
    expect(r.chunks[r.chunks.length - 1]!.payload).toContain(imageUri(10_000));
  });

  it('replaces data URIs above maxEventBytes and keeps the event valid', () => {
    const r = setup({ maxEventBytes: 20_000, maxPayloadBytes: 100_000 });
    r.core.handleEvent(meta());
    r.core.handleEvent(
      ev(2, {
        node: {
          id: 1,
          attributes: { src: imageUri(30_000) },
          css: `@font-face{src:url("data:font/woff2;base64,${'F'.repeat(30_000)}")}`,
        },
        initialOffset: { top: 0, left: 0 },
      }),
    );
    r.core.flush();
    const chunk = r.chunks[r.chunks.length - 1]!;
    expect(chunk.is_full_snapshot).toBe(true);
    expect(utf8ByteLength(chunk.payload)).toBeLessThan(2000);
    const [, full] = JSON.parse(chunk.payload);
    expect(full.data.node.attributes.src).toBe(PLACEHOLDER_IMAGE_DATA_URI);
    expect(full.data.node.css).toBe('@font-face{src:url("")}');
  });

  it('drops an event that is still over the hard cap after shrinking', () => {
    const r = setup();
    r.core.handleEvent(mutation('t'.repeat(11 * 1024 * 1024)));
    r.core.handleEvent(mouseMove());
    r.core.flush();
    expect(r.events().map((e) => e.type)).toEqual([4, 2, 3]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('dropping oversized event'),
      expect.anything(),
    );
  });
});
