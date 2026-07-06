import type { eventWithTime } from 'rrweb';
import { record } from 'rrweb';

export type ReplayRecorderConfig = {
  maskAllInputs?: boolean;
  maskAllText?: boolean;
  unmaskTextSelector?: string;
  blockSelector?: string;
  blockClass?: string;
  ignoreSelector?: string;
  flushIntervalMs?: number;
  maxEventsPerChunk?: number;
  maxPayloadBytes?: number;
  /**
   * How long (ms) without a real user interaction before the recorder goes
   * idle and stops capturing. Default 5 min (matches PostHog). While idle,
   * background DOM churn (a poll re-rendering, a "5 minutes ago" label
   * ticking, an animation) is dropped instead of recorded — so a forgotten
   * tab does not produce a multi-hour ghost recording.
   */
  idleThresholdMs?: number;
};

// rrweb IncrementalSource values that represent genuine USER activity.
// Notably absent: source 0 (Mutation) — DOM mutations happen from background
// work too, so they must NOT count as activity. Mirrors PostHog's ACTIVE_SOURCES.
//   1 MouseMove · 2 MouseInteraction · 3 Scroll · 4 ViewportResize
//   5 Input · 6 TouchMove · 7 MediaInteraction · 12 Drag
const ACTIVE_SOURCES = new Set([1, 2, 3, 4, 5, 6, 7, 12]);

const DEFAULT_IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 min (matches PostHog)

// Absolute ceiling for a SINGLE event sent as its own chunk. maxPayloadBytes
// (default 1 MB) is only the batch-split threshold — a single event that
// exceeds it is still sent alone, because dropping it corrupts the recording:
// dropping a FullSnapshot leaves the player with no rebuild anchor (seek
// lands on "Node not found" → black frame), and dropping a mutation breaks
// the DOM mirror chain for everything after it. Only beyond this hard cap do
// we drop, loudly. The ingest API accepts far larger bodies (500 MB).
const HARD_EVENT_CAP_BYTES = 10 * 1024 * 1024; // 10 MB

/** An event counts as user activity only if it's an interactive incremental. */
function isInteractiveEvent(event: eventWithTime): boolean {
  return (
    event.type === 3 /* IncrementalSnapshot */ &&
    ACTIVE_SOURCES.has(
      (event.data as { source?: number } | undefined)?.source ?? -1,
    )
  );
}

export type ReplayChunkPayload = {
  chunk_index: number;
  events_count: number;
  is_full_snapshot: boolean;
  started_at: string;
  ended_at: string;
  payload: string;
};

let stopRecording: (() => void) | null = null;

export function startReplayRecorder(
  config: ReplayRecorderConfig,
  sendChunk: (payload: ReplayChunkPayload) => void,
  /**
   * Called on each genuine user interaction (mouse/click/scroll/input/...).
   * The SDK uses this to bump session activity — so ONLY real interactions
   * extend the session, never background DOM churn.
   */
  onUserActivity?: () => void,
): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  // Stop any existing recorder before starting a new one
  if (stopRecording) {
    stopRecording();
  }

  const maxEventsPerChunk = config.maxEventsPerChunk ?? 200;
  const flushIntervalMs = config.flushIntervalMs ?? 10_000;
  const maxPayloadBytes = config.maxPayloadBytes ?? 1_048_576; // 1 MB
  const idleThresholdMs = config.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;

  let buffer: eventWithTime[] = [];
  let chunkIndex = 0;
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  // Idle state (PostHog-style). We start "active" so the initial snapshot is
  // always captured. lastActivityMs tracks the last real user interaction.
  let isIdle = false;
  let lastActivityMs = Date.now();
  // MouseMove/Scroll fire many times a second and each onUserActivity() bump
  // writes localStorage. Throttle the notify to at most once/sec — lastActivityMs
  // still updates on every interactive event (in-memory, cheap).
  let lastActivityNotifyMs = 0;

  function flush(): void {
    if (buffer.length === 0) return;

    const payloadJson = JSON.stringify(buffer);
    const payloadBytes = new TextEncoder().encode(payloadJson).length;

    if (payloadBytes > maxPayloadBytes) {
      // Recursively split oversized batches so each request stays small.
      if (buffer.length > 1) {
        const mid = Math.floor(buffer.length / 2);
        const firstHalf = buffer.slice(0, mid);
        const secondHalf = buffer.slice(mid);
        buffer = firstHalf;
        flush();
        buffer = secondHalf;
        flush();
        return;
      }
      // A single event over the split threshold is sent as its own chunk —
      // see HARD_EVENT_CAP_BYTES for why dropping it is never acceptable.
      if (payloadBytes > HARD_EVENT_CAP_BYTES) {
        console.warn(
          '[OpenPanel.replay] dropping oversized event — replay may be broken from this point',
          { type: buffer[0]!.type, bytes: payloadBytes },
        );
        buffer = [];
        return;
      }
    }

    // A chunk "is" a full snapshot iff it actually contains a type-2 event.
    // Derived from content — never from the checkout flag — because the
    // dashboard's seek anchoring queries chunks by this column.
    const isFullSnapshot = buffer.some((e) => e.type === 2);
    const startedAt = buffer[0]!.timestamp;
    const endedAt = buffer[buffer.length - 1]!.timestamp;

    try {
      sendChunk({
        chunk_index: chunkIndex,
        events_count: buffer.length,
        is_full_snapshot: isFullSnapshot,
        started_at: new Date(startedAt).toISOString(),
        ended_at: new Date(endedAt).toISOString(),
        payload: payloadJson,
      });
      chunkIndex += 1;
      buffer = [];
    } catch (err) {
      console.error('[OpenPanel.replay] sendChunk failed', err);
      throw err;
    }
  }

  function flushIfNeeded(isCheckout: boolean): void {
    // On checkout, flush immediately so the FullSnapshot begins a fresh,
    // cleanly-bounded chunk (the is_full_snapshot column is derived from
    // chunk content inside flush()).
    if (buffer.length >= maxEventsPerChunk || (isCheckout && buffer.length > 0)) {
      flush();
    }
  }

  const maskAllText = config.maskAllText !== false;
  const unmaskTextSelector = config.unmaskTextSelector;

  const stopFn = record({
    emit(event: eventWithTime, isCheckout?: boolean) {
      const interactive = isInteractiveEvent(event);

      if (interactive) {
        lastActivityMs = event.timestamp;
        if (event.timestamp - lastActivityNotifyMs >= 1000) {
          lastActivityNotifyMs = event.timestamp;
          onUserActivity?.();
        }
        if (isIdle) {
          // Returning from idle. The player's DOM mirror is stale (we dropped
          // the mutations that happened while idle), so force a fresh
          // FullSnapshot to give playback a clean anchor before resuming.
          isIdle = false;
          try {
            record.takeFullSnapshot?.(true);
          } catch {
            // takeFullSnapshot unavailable — the next checkoutEveryNms snapshot
            // will re-anchor shortly; not fatal.
          }
        }
      } else if (!isIdle && event.timestamp - lastActivityMs > idleThresholdMs) {
        // No real interaction for idleThresholdMs. Go idle: flush what we have
        // and stop capturing so background churn doesn't grow a ghost recording.
        isIdle = true;
        flush();
      }

      // While idle, drop events entirely — no buffering, no chunks.
      if (isIdle) return;

      buffer.push(event);
      flushIfNeeded(!!isCheckout);
    },
    checkoutEveryNms: flushIntervalMs,
    maskAllInputs: config.maskAllInputs ?? true,
    maskTextSelector: maskAllText ? '*' : '[data-openpanel-replay-mask]',
    maskTextFn:
      maskAllText && unmaskTextSelector
        ? (text, element) => {
            if (element?.closest(unmaskTextSelector)) return text;
            return text.replace(/\S/g, '*');
          }
        : undefined,
    blockSelector: config.blockSelector ?? '[data-openpanel-replay-block]',
    blockClass: config.blockClass,
    ignoreSelector: config.ignoreSelector,
  });

  flushTimer = setInterval(() => {
    flush();
  }, flushIntervalMs);

  function onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') {
      flush();
    }
  }

  function onPageHide(): void {
    flush();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);

  stopRecording = () => {
    // Final flush before teardown
    flush();
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    stopFn?.();
    stopRecording = null;
  };
}

export function stopReplayRecorder(): void {
  if (stopRecording) {
    stopRecording();
  }
}
