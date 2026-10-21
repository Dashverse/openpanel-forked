import type { eventWithTime } from 'rrweb';
import { DEFAULT_IDLE_TIMEOUT_MS } from '../session-id-manager';
import { shrinkDataUris, utf8ByteLength } from './size-utils';

/**
 * Recorder state machine: buffering, chunking, idle detection and full
 * snapshot scheduling. Knows nothing about rrweb's runtime or the DOM (the
 * recorder wires rrweb's emit, timers and page events into it), so all of
 * its behaviour is unit-testable. Modelled on PostHog's
 * lazy-loaded-session-recorder.ts.
 */

export type ReplayChunkPayload = {
  chunk_index: number;
  events_count: number;
  is_full_snapshot: boolean;
  started_at: string;
  ended_at: string;
  payload: string;
};

// rrweb EventType / IncrementalSource values, as plain numbers so this module
// does not pull rrweb in at runtime.
const FULL_SNAPSHOT = 2;
const INCREMENTAL_SNAPSHOT = 3;
const META = 4;

// rrweb IncrementalSource values that represent genuine USER activity.
// Notably absent: source 0 (Mutation) - DOM mutations happen from background
// work too, so they must NOT count as activity. Mirrors PostHog's ACTIVE_SOURCES.
//   1 MouseMove, 2 MouseInteraction, 3 Scroll, 4 ViewportResize,
//   5 Input, 6 TouchMove, 7 MediaInteraction, 12 Drag
const ACTIVE_SOURCES = new Set([1, 2, 3, 4, 5, 6, 7, 12]);

export const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
export const DEFAULT_FULL_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // PostHog: FIVE_MINUTES
export const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60 * 1000; // PostHog: RECORDING_IDLE_THRESHOLD_MS
export const DEFAULT_MAX_EVENTS_PER_CHUNK = 200;
// Stop capturing after this long without user activity: the session idle
// timeout, so a forgotten tab cannot keep a session alive (every replay send
// reads the session id, which rotates once it expired).
export const DEFAULT_STOP_AFTER_IDLE_MS = DEFAULT_IDLE_TIMEOUT_MS;
// Go dormant this much before stopAfterIdleMs (at most 10% of it), so the
// final chunk is still sent under the live session and never rotates it.
const DORMANT_LEAD_MS = 60_000;
// Soft cap per chunk (UTF-8 bytes of the payload JSON). PostHog flushes at
// 0.9 MB; we stay lower because the payload travels JSON-escaped inside the
// /track body (every `"` becomes `\"`) and the server must keep each message
// under 1 MB.
export const DEFAULT_MAX_PAYLOAD_BYTES = 800 * 1024;
// A single event larger than this gets its data URIs replaced (PostHog's
// MAX_MESSAGE_SIZE). Below it the server carries the event as-is.
export const DEFAULT_MAX_EVENT_BYTES = 5 * 1024 * 1024;

// Absolute ceiling for a SINGLE event, checked after data URIs were shrunk.
// A single event over the chunk cap is still sent alone, because dropping it
// corrupts the recording: dropping a FullSnapshot leaves the player with no
// rebuild anchor (seek lands on "Node not found", black frame), and dropping a
// mutation breaks the DOM mirror chain for everything after it. Only beyond
// this hard cap do we drop, loudly.
export const HARD_EVENT_CAP_BYTES = 10 * 1024 * 1024; // 10 MB

// MouseMove/Scroll fire many times a second and each onUserActivity() bump
// writes localStorage. Notify at most once/sec; lastActivityMs still updates
// on every interactive event (in-memory, cheap).
const ACTIVITY_NOTIFY_THROTTLE_MS = 1000;

/** An event counts as user activity only if it's an interactive incremental. */
export function isInteractiveEvent(event: eventWithTime): boolean {
  return (
    event.type === INCREMENTAL_SNAPSHOT &&
    ACTIVE_SOURCES.has(
      (event.data as { source?: number } | undefined)?.source ?? -1,
    )
  );
}

export type ReplayCoreOptions = {
  flushIntervalMs?: number;
  /**
   * 0 disables periodic and wake-up snapshots (the initial one is always
   * taken).
   */
  fullSnapshotIntervalMs?: number;
  idleThresholdMs?: number;
  /**
   * Session idle timeout the recording must stay inside. With no activity
   * for (just under) this long the recorder goes dormant: flush, then drop
   * everything until the user is back. 0 disables dormancy.
   */
  stopAfterIdleMs?: number;
  maxEventsPerChunk?: number;
  maxPayloadBytes?: number;
  maxEventBytes?: number;
  /** First chunk_index to emit (a restart continuing the same window). */
  startChunkIndex?: number;
};

export type ReplayCoreDeps = {
  sendChunk: (payload: ReplayChunkPayload) => void;
  /** Ask rrweb for a FullSnapshot; it re-enters handleEvent synchronously. */
  takeFullSnapshot: () => void;
  onUserActivity?: () => void;
  now?: () => number;
};

type BufferedEvent = {
  json: string;
  bytes: number;
  type: number;
  timestamp: number;
};

// "[" + "]" around the joined events.
const EMPTY_PAYLOAD_BYTES = 2;

export class ReplayRecorderCore {
  private readonly flushIntervalMs: number;
  private readonly fullSnapshotIntervalMs: number;
  private readonly idleThresholdMs: number;
  private readonly stopAfterIdleMs: number;
  private readonly dormantAfterMs: number;
  private readonly maxEventsPerChunk: number;
  private readonly maxPayloadBytes: number;
  private readonly maxEventBytes: number;
  private readonly now: () => number;

  private buffer: BufferedEvent[] = [];
  private bufferBytes = EMPTY_PAYLOAD_BYTES;
  private chunkIndex: number;

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private fullSnapshotTimer: ReturnType<typeof setInterval> | null = null;

  // Two levels of "no user activity", tracked from lastActivityMs (the last
  // real user interaction). We start active.
  //   idle (idleThresholdMs, default 5 min): only pauses the periodic full
  //     snapshots. Every event is still recorded: users watch a video render
  //     or a chat answer stream for minutes without touching anything, and
  //     that is exactly what the replay must show.
  //   dormant (stopAfterIdleMs, default the 30 min session timeout): flush,
  //     then drop everything until the user is back. This is PostHog's idle
  //     (which drops after 5 min), with a window as long as the session.
  private isIdle = false;
  private isDormant = false;
  private lastActivityMs: number;
  private lastActivityNotifyMs = Number.NEGATIVE_INFINITY;
  // Timestamp of the last FullSnapshot buffered (the last seek checkpoint).
  private lastFullSnapshotMs = Number.NEGATIVE_INFINITY;
  private wasHidden = false;
  private stopped = false;

  constructor(
    options: ReplayCoreOptions,
    private readonly deps: ReplayCoreDeps,
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.fullSnapshotIntervalMs =
      options.fullSnapshotIntervalMs ?? DEFAULT_FULL_SNAPSHOT_INTERVAL_MS;
    this.idleThresholdMs = options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.stopAfterIdleMs =
      options.stopAfterIdleMs ?? DEFAULT_STOP_AFTER_IDLE_MS;
    this.dormantAfterMs =
      this.stopAfterIdleMs -
      Math.min(DORMANT_LEAD_MS, this.stopAfterIdleMs / 10);
    this.maxEventsPerChunk =
      options.maxEventsPerChunk ?? DEFAULT_MAX_EVENTS_PER_CHUNK;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.chunkIndex = options.startChunkIndex ?? 0;
    this.now = deps.now ?? (() => Date.now());
    this.lastActivityMs = this.now();
  }

  /** Start the flush and full snapshot timers. */
  start(): void {
    if (this.stopped || this.flushTimer) return;
    // flush() also checks dormancy, so a static page (no events at all)
    // still goes dormant on time.
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.scheduleFullSnapshot();
  }

  /** Final flush, then clear timers. Later events are ignored. */
  stop(): void {
    if (this.stopped) return;
    this.flush();
    this.stopped = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.clearFullSnapshotTimer();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get idle(): boolean {
    return this.isIdle;
  }

  get dormant(): boolean {
    return this.isDormant;
  }

  /** rrweb emit handler. */
  handleEvent(event: eventWithTime): void {
    if (this.stopped) return;

    if (isInteractiveEvent(event)) {
      this.lastActivityMs = event.timestamp;
      this.notifyActivity(event.timestamp);
      // The activity bump can rotate an expired session, and the SDK then
      // stops this recorder and starts a fresh one (which takes its own
      // FullSnapshot). Nothing more to do here.
      if (this.stopped) return;
      if (this.isDormant) this.wakeFromDormancy();
      else if (this.isIdle) this.wake();
    } else {
      // Dormant: drop it (no buffering, no sends, no session reads).
      if (this.enterDormancyIfDue(event.timestamp)) return;
      if (
        !this.isIdle &&
        event.timestamp - this.lastActivityMs > this.idleThresholdMs
      ) {
        // No real interaction for idleThresholdMs: pause periodic snapshots.
        // The event itself is still recorded below, like everything else.
        this.goIdle();
      }
    }

    this.add(event);
  }

  /** document visibilitychange handler. */
  handleVisibilityChange(visible: boolean): void {
    if (this.stopped) return;
    if (!visible) {
      this.wasHidden = true;
      this.flush();
      return;
    }
    if (!this.wasHidden) return;
    this.wasHidden = false;
    // Coming back to a tab that went idle while away counts as the first
    // activity after idle: resume snapshots right away instead of waiting
    // for a mouse move. A tab that never went idle has its timer running
    // already, and a snapshot per tab switch would only add bytes (PostHog
    // takes none on visibility at all).
    if (!this.isIdle && !this.isDormant) return;
    const now = this.now();
    this.lastActivityMs = now;
    this.notifyActivity(now);
    if (this.stopped) return;
    if (this.isDormant) this.wakeFromDormancy();
    else this.wake();
  }

  /** Send the buffer as a chunk, unless the recorder is (now) dormant. */
  flush(): void {
    if (this.enterDormancyIfDue(this.now())) return;
    this.sendBuffer();
  }

  private sendBuffer(): void {
    if (this.buffer.length === 0) return;

    // Detach the buffer BEFORE sending: sendChunk can synchronously rotate
    // the session, which stops this recorder and re-enters flush(). The
    // re-entrant call must see an empty buffer, not send these events twice.
    const events = this.buffer;
    this.buffer = [];
    this.bufferBytes = EMPTY_PAYLOAD_BYTES;
    const chunkIndex = this.chunkIndex;
    this.chunkIndex += 1;

    let startedAt = Number.POSITIVE_INFINITY;
    let endedAt = Number.NEGATIVE_INFINITY;
    // A chunk "is" a full snapshot iff it actually contains a type-2 event.
    // Derived from content, because the dashboard's seek anchoring queries
    // chunks by this column.
    let isFullSnapshot = false;
    const parts: string[] = [];
    for (const e of events) {
      if (e.timestamp < startedAt) startedAt = e.timestamp;
      if (e.timestamp > endedAt) endedAt = e.timestamp;
      if (e.type === FULL_SNAPSHOT) isFullSnapshot = true;
      parts.push(e.json);
    }

    try {
      this.deps.sendChunk({
        chunk_index: chunkIndex,
        events_count: events.length,
        is_full_snapshot: isFullSnapshot,
        started_at: new Date(startedAt).toISOString(),
        ended_at: new Date(endedAt).toISOString(),
        // Same string JSON.stringify(events) would produce.
        payload: `[${parts.join(',')}]`,
      });
    } catch (err) {
      console.error('[OpenPanel.replay] sendChunk failed', err);
      throw err;
    }
  }

  private add(event: eventWithTime): void {
    // Serialize once, now: the string is both the size estimate and the
    // payload, so flush() only joins strings.
    let json: string;
    try {
      json = JSON.stringify(event);
    } catch (err) {
      console.warn('[OpenPanel.replay] dropping unserializable event', {
        type: event.type,
        err,
      });
      return;
    }
    let bytes = utf8ByteLength(json);

    if (bytes > this.maxEventBytes) {
      const shrunk = shrinkDataUris(json);
      if (shrunk !== json) {
        const shrunkBytes = utf8ByteLength(shrunk);
        console.warn(
          '[OpenPanel.replay] replaced data URIs in oversized event',
          {
            type: event.type,
            bytes,
            shrunkBytes,
          },
        );
        json = shrunk;
        bytes = shrunkBytes;
      }
    }

    if (bytes > HARD_EVENT_CAP_BYTES) {
      console.warn(
        '[OpenPanel.replay] dropping oversized event - replay may be broken from this point',
        { type: event.type, bytes },
      );
      return;
    }

    const last = this.buffer[this.buffer.length - 1];
    // rrweb emits Meta then FullSnapshot for every snapshot. Keep the pair
    // together and at the START of a chunk, so the chunk the seek anchor
    // loads carries the viewport Meta too and never begins with stale
    // incrementals.
    const joinsMeta = event.type === FULL_SNAPSHOT && last?.type === META;
    if (this.buffer.length > 0 && !joinsMeta) {
      const startsSnapshot =
        event.type === META || event.type === FULL_SNAPSHOT;
      // Size-based early flush (PostHog's RECORDING_MAX_EVENT_SIZE check in
      // _captureSnapshotBuffered): never let this event push the chunk over
      // the cap, so a chunk is only big when it is one huge event.
      const overflows = this.bufferBytes + 1 + bytes > this.maxPayloadBytes;
      if (startsSnapshot || overflows) this.sendBuffer();
    }

    this.bufferBytes += (this.buffer.length > 0 ? 1 : 0) + bytes;
    this.buffer.push({
      json,
      bytes,
      type: event.type,
      timestamp: event.timestamp,
    });

    // Every FullSnapshot restarts the periodic clock (PostHog reschedules on
    // each FullSnapshot it processes), so snapshots stay one interval apart.
    if (event.type === FULL_SNAPSHOT) {
      this.lastFullSnapshotMs = event.timestamp;
      this.scheduleFullSnapshot();
    }

    if (
      this.buffer.length >= this.maxEventsPerChunk ||
      this.bufferBytes >= this.maxPayloadBytes
    ) {
      // Already at the cap (a single huge event): nothing can join it, so
      // ship it now instead of holding it until the next tick.
      this.sendBuffer();
    }
  }

  private notifyActivity(at: number): void {
    if (at - this.lastActivityNotifyMs < ACTIVITY_NOTIFY_THROTTLE_MS) return;
    this.lastActivityNotifyMs = at;
    this.deps.onUserActivity?.();
  }

  private goIdle(): void {
    this.isIdle = true;
    // Don't take full snapshots while idle. Events keep flowing as normal.
    this.clearFullSnapshotTimer();
  }

  /**
   * Enter the dormant state once no user activity for dormantAfterMs.
   * Returns true while dormant. Checked on every non-interactive event and
   * on every flush (the flush timer covers pages that emit nothing).
   */
  private enterDormancyIfDue(at: number): boolean {
    if (this.isDormant) return true;
    if (
      !this.stopAfterIdleMs ||
      at - this.lastActivityMs < this.dormantAfterMs
    ) {
      return false;
    }
    // Normally we get here in the lead window before the session expires,
    // and the last chunk is sent. Detected late (timers in a hidden tab can
    // run a minute behind), the session may already have expired, and
    // sending would rotate it and restart recording. Discard instead: at
    // most one flush interval of idle churn.
    const sessionMayHaveExpired =
      at - this.lastActivityMs >=
      this.stopAfterIdleMs - ACTIVITY_NOTIFY_THROTTLE_MS;
    if (sessionMayHaveExpired) {
      this.buffer = [];
      this.bufferBytes = EMPTY_PAYLOAD_BYTES;
    } else {
      this.sendBuffer();
    }
    this.isDormant = true;
    this.isIdle = true;
    this.clearFullSnapshotTimer();
    return true;
  }

  private wakeFromDormancy(): void {
    this.isDormant = false;
    this.isIdle = false;
    this.scheduleFullSnapshot();
    // Events were dropped while dormant, so the player's mirror is out of
    // sync: always re-anchor, whatever fullSnapshotIntervalMs says.
    this.requestFullSnapshot();
  }

  private wake(): void {
    this.isIdle = false;
    this.scheduleFullSnapshot();
    // Nothing was dropped while idle, so the mirror is in sync. But after a
    // long idle stretch the last seek checkpoint is old: take a fresh one if
    // it is older than the interval (re-entrant: rrweb emits Meta +
    // FullSnapshot through handleEvent right here, which also restarts the
    // timer).
    if (
      this.fullSnapshotIntervalMs &&
      this.now() - this.lastFullSnapshotMs >= this.fullSnapshotIntervalMs
    ) {
      this.requestFullSnapshot();
    }
  }

  private scheduleFullSnapshot(): void {
    this.clearFullSnapshotTimer();
    if (this.stopped || this.isIdle || !this.fullSnapshotIntervalMs) return;
    this.fullSnapshotTimer = setInterval(
      () => this.onFullSnapshotTimer(),
      this.fullSnapshotIntervalMs,
    );
  }

  private clearFullSnapshotTimer(): void {
    if (this.fullSnapshotTimer) clearInterval(this.fullSnapshotTimer);
    this.fullSnapshotTimer = null;
  }

  private onFullSnapshotTimer(): void {
    if (this.stopped || this.isIdle) return;
    if (this.enterDormancyIfDue(this.now())) return;
    // Idle detection otherwise needs an event to arrive. On a static page
    // nothing does, so check the clock here and skip the snapshot (PostHog
    // takes it and then drops it).
    if (this.now() - this.lastActivityMs >= this.idleThresholdMs) {
      this.goIdle();
      return;
    }
    this.requestFullSnapshot();
  }

  private requestFullSnapshot(): void {
    try {
      this.deps.takeFullSnapshot();
    } catch {
      // rrweb not recording yet (document still loading) or already stopped.
      // The next periodic snapshot re-anchors; not fatal.
    }
  }
}
