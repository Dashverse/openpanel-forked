import type { eventWithTime } from 'rrweb';
import { record } from 'rrweb';
import { ReplayRecorderCore } from './recorder-core';
import type { ReplayChunkPayload } from './recorder-core';

export type { ReplayChunkPayload } from './recorder-core';

export type ReplayRecorderConfig = {
  maskAllInputs?: boolean;
  maskAllText?: boolean;
  unmaskTextSelector?: string;
  blockSelector?: string;
  blockClass?: string;
  ignoreSelector?: string;
  /** How often buffered events are sent as a chunk. Default 10 s. */
  flushIntervalMs?: number;
  /**
   * How often a fresh FullSnapshot is taken while the user is active.
   * Default 5 min (matches PostHog). Independent of flushIntervalMs: a full
   * snapshot re-serializes the whole page, so taking one per flush made
   * snapshots the bulk of every recording. Paused while idle; on the first
   * activity after idle one is taken if the last is older than this. 0 turns
   * periodic and wake-up snapshots off (the initial one still happens).
   */
  fullSnapshotIntervalMs?: number;
  maxEventsPerChunk?: number;
  /**
   * Soft cap on a chunk's payload size in bytes. A chunk is flushed early
   * as soon as the next event would push it over, so only a single huge
   * event can exceed it (it is sent alone). Default 800 KB.
   */
  maxPayloadBytes?: number;
  /**
   * A single event larger than this has its data URIs replaced (images by a
   * small placeholder, everything else removed) before it is sent. Default
   * 5 MB (matches PostHog's ensureMaxMessageSize).
   */
  maxEventBytes?: number;
  /**
   * How long (ms) without a real user interaction before the recorder goes
   * idle. Default 5 min (matches PostHog). Idle only pauses the periodic
   * full snapshots: every change (a video rendering, a chat answer
   * streaming) is still recorded, unlike PostHog, which drops events while
   * idle.
   */
  idleThresholdMs?: number;
  /**
   * Stop capturing after this long without a real user interaction (or the
   * tab coming back into view): flush, then drop everything until the user
   * returns, when a fresh FullSnapshot is taken. Default the SDK's 30 min
   * session idle timeout; capture stops 1 min before it so the last chunk
   * never rotates the session. Without this a forgotten tab with any DOM
   * churn would record forever, opening a new session every 30 min.
   * 0 disables it.
   */
  stopAfterIdleMs?: number;
};

let stopRecording: (() => void) | null = null;

export function startReplayRecorder(
  config: ReplayRecorderConfig,
  sendChunk: (payload: ReplayChunkPayload) => void,
  /**
   * Called on each genuine user interaction (mouse/click/scroll/input/...).
   * The SDK uses this to bump session activity - so ONLY real interactions
   * extend the session, never background DOM churn.
   */
  onUserActivity?: () => void,
  /**
   * First chunk_index to emit. A restart within the same window_id must
   * continue the sequence, or different chunks collide on
   * (window_id, chunk_index). Default 0.
   */
  startChunkIndex = 0,
): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  // Stop any existing recorder before starting a new one
  if (stopRecording) {
    stopRecording();
  }

  const core = new ReplayRecorderCore(
    {
      flushIntervalMs: config.flushIntervalMs,
      fullSnapshotIntervalMs: config.fullSnapshotIntervalMs,
      idleThresholdMs: config.idleThresholdMs,
      stopAfterIdleMs: config.stopAfterIdleMs,
      maxEventsPerChunk: config.maxEventsPerChunk,
      maxPayloadBytes: config.maxPayloadBytes,
      maxEventBytes: config.maxEventBytes,
      startChunkIndex,
    },
    {
      sendChunk,
      onUserActivity,
      // record.takeFullSnapshot targets the most recent record() call, which
      // is this recorder for as long as the core is not stopped.
      takeFullSnapshot: () => record.takeFullSnapshot?.(true),
    },
  );

  const maskAllText = config.maskAllText !== false;
  const unmaskTextSelector = config.unmaskTextSelector;

  // No checkoutEveryNms: rrweb checks it on every emitted event, so it keeps
  // re-snapshotting an idle tab with background churn, and it cannot be
  // paused. The core runs its own snapshot timer instead
  // (PostHog does the same with setInterval + takeFullSnapshot).
  const stopFn = record({
    emit(event: eventWithTime) {
      core.handleEvent(event);
    },
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

  core.start();

  function onVisibilityChange(): void {
    core.handleVisibilityChange(document.visibilityState !== 'hidden');
  }

  function onPageHide(): void {
    core.flush();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);

  const stop = () => {
    if (stopRecording === stop) stopRecording = null;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    // Stop rrweb FIRST, then the final flush. The flush can rotate the
    // session and synchronously start the next recorder; stopping rrweb
    // after that would clear rrweb's module-level `recording` flag under the
    // new recorder and break its takeFullSnapshot.
    stopFn?.();
    core.stop();
  };
  stopRecording = stop;
}

export function stopReplayRecorder(): void {
  if (stopRecording) {
    stopRecording();
  }
}
