import { localStore } from './storage';

/**
 * SessionIdManager — client-owned session_id, PostHog-style.
 *
 * Owns three pieces of state in localStorage so all tabs of the same origin
 * see the same session:
 *   - _op_session_id       — current session UUID
 *   - _op_session_start_ms — when this session was created (for 24-hr max cap)
 *   - _op_last_activity_ms — last time ANY tab reported user activity
 *
 * Rotation rules (mirrors PostHog's contract):
 *   1. No session in storage → create one on first getSessionId()
 *   2. now - last_activity > idleTimeoutMs → rotate
 *   3. now - session_start > maxSessionMs → rotate
 *
 * Cross-tab activity is respected because `_op_last_activity_ms` is read
 * FRESH from localStorage on every rotation check — so an idle tab won't
 * rotate the session while a sibling tab is keeping it alive with events.
 *
 * Rotation is lazy — checked on getSessionId() calls, not on a background
 * timer. This means the very first event after an idle period pays the
 * rotation cost (~1ms), but there's no timer to leak, no cleanup on tab
 * close, and no coordinated wake-up across tabs.
 *
 * Subscribers (typically the replay recorder) register via
 * onSessionIdChanged. When rotation happens, the callback fires
 * synchronously so the recorder can teardown + restart with the new id.
 *
 * If localStorage is unavailable (SSR, sandboxed iframe, private mode
 * with quota errors), falls back to in-memory state. Session won't
 * persist across page reloads in that case, but the SDK stays functional.
 */

const SESSION_ID_KEY = '_op_session_id';
const SESSION_START_KEY = '_op_session_start_ms';
const LAST_ACTIVITY_KEY = '_op_last_activity_ms';

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const DEFAULT_MAX_SESSION_MS = 24 * 60 * 60 * 1000; // 24 hrs

export type SessionIdChangedCallback = (
  newSessionId: string,
  previousSessionId: string | null,
) => void;

export type SessionIdManagerOptions = {
  /** Idle-timeout before rotation. Default 30 min. */
  idleTimeoutMs?: number;
  /** Hard cap on session length regardless of activity. Default 24 hrs. */
  maxSessionMs?: number;
  /** Override for id generation (tests). Default: crypto.randomUUID with Math.random fallback. */
  sessionIdGenerator?: () => string;
  /** Override for time (tests). Default: Date.now. */
  now?: () => number;
};

type SessionState = {
  sessionId: string | null;
  sessionStartMs: number | null;
  lastActivityMs: number | null;
};

export class SessionIdManager {
  private readonly idleTimeoutMs: number;
  private readonly maxSessionMs: number;
  private readonly generateSessionId: () => string;
  private readonly now: () => number;
  private callbacks: SessionIdChangedCallback[] = [];

  // Fallback state when localStorage is unavailable. Not persisted; each
  // page load starts fresh in that case (acceptable degradation).
  private memoryState: SessionState = {
    sessionId: null,
    sessionStartMs: null,
    lastActivityMs: null,
  };

  constructor(opts: SessionIdManagerOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxSessionMs = opts.maxSessionMs ?? DEFAULT_MAX_SESSION_MS;
    this.generateSessionId = opts.sessionIdGenerator ?? defaultUuidGenerator;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Returns the current session_id, rotating first if the stored session
   * has aged out. Safe to call from any code path — cheap when no rotation
   * is needed (single localStorage read).
   */
  getSessionId(): string {
    const state = this.readState();
    const now = this.now();

    if (this.shouldRotate(state, now)) {
      return this.rotate(state.sessionId, now);
    }

    return state.sessionId as string;
  }

  /**
   * Records user activity — call from every event capture and every rrweb
   * emit. Updates localStorage so sibling tabs see this tab as active and
   * don't rotate the session.
   */
  bumpActivity(): void {
    this.writeActivity(this.now());
  }

  /**
   * Subscribe to session_id changes. Fires synchronously after a rotation
   * completes. Returns an unsubscribe function.
   *
   * Typical use: replay recorder subscribes on init, tears down its rrweb
   * instance and starts a new one with the new session_id.
   */
  onSessionIdChanged(cb: SessionIdChangedCallback): () => void {
    this.callbacks.push(cb);
    return () => {
      this.callbacks = this.callbacks.filter((c) => c !== cb);
    };
  }

  /**
   * Force-rotate to a new session_id. For sign-out flows or consumer-
   * triggered session boundaries.
   */
  reset(): void {
    const previous = this.readState().sessionId;
    this.rotate(previous, this.now());
  }

  private shouldRotate(state: SessionState, now: number): boolean {
    if (!state.sessionId) return true;
    if (state.sessionStartMs === null) return true;
    if (state.lastActivityMs === null) return true;

    if (now - state.lastActivityMs > this.idleTimeoutMs) return true;
    if (now - state.sessionStartMs > this.maxSessionMs) return true;

    return false;
  }

  private rotate(previousId: string | null, now: number): string {
    const nextId = this.generateSessionId();
    this.writeState({
      sessionId: nextId,
      sessionStartMs: now,
      lastActivityMs: now,
    });
    this.emit(nextId, previousId);
    return nextId;
  }

  private readState(): SessionState {
    const rawSessionId = localStore.get(SESSION_ID_KEY);

    if (rawSessionId === null) {
      // localStorage unavailable or empty — return memory state (which will
      // trigger rotation on first read if it's also empty)
      return { ...this.memoryState };
    }

    const rawStart = localStore.get(SESSION_START_KEY);
    const rawActivity = localStore.get(LAST_ACTIVITY_KEY);

    return {
      sessionId: rawSessionId,
      sessionStartMs: parseTimestamp(rawStart),
      lastActivityMs: parseTimestamp(rawActivity),
    };
  }

  private writeState(state: {
    sessionId: string;
    sessionStartMs: number;
    lastActivityMs: number;
  }): void {
    const idOk = localStore.set(SESSION_ID_KEY, state.sessionId);
    localStore.set(SESSION_START_KEY, String(state.sessionStartMs));
    localStore.set(LAST_ACTIVITY_KEY, String(state.lastActivityMs));

    if (!idOk) {
      this.memoryState = { ...state };
    }
  }

  private writeActivity(now: number): void {
    if (!localStore.set(LAST_ACTIVITY_KEY, String(now))) {
      this.memoryState.lastActivityMs = now;
    }
  }

  private emit(newId: string, previousId: string | null): void {
    for (const cb of this.callbacks.slice()) {
      try {
        cb(newId, previousId);
      } catch {
        // A subscriber threw. Don't let it break rotation for other
        // subscribers. Failures here should not cascade.
      }
    }
  }
}

function parseTimestamp(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function defaultUuidGenerator(): string {
  try {
    if (
      typeof crypto !== 'undefined' &&
      typeof crypto.randomUUID === 'function'
    ) {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to Math.random path
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
