import type {
  OpenPanelOptions as OpenPanelBaseOptions,
  TrackProperties,
} from '@openpanel/sdk';
import { OpenPanel as OpenPanelBase } from '@openpanel/sdk';
import {
  type ReplayRecorderConfig,
  startReplayRecorder,
  stopReplayRecorder,
} from './replay';
import { SessionIdManager } from './session-id-manager';

export type * from '@openpanel/sdk';
export { OpenPanel as OpenPanelBase } from '@openpanel/sdk';

export type SessionReplayOptions = ReplayRecorderConfig & {
  enabled: boolean;
  /**
   * Fraction of sessions to record. 0..1 (default 1 = record all).
   */
  sampleRate?: number;
  /**
   * Max milliseconds to wait for a session_id (established by a track call)
   * before giving up on starting the recorder. Default 10000.
   */
  startTimeoutMs?: number;
};

export type OpenPanelOptions = OpenPanelBaseOptions & {
  trackOutgoingLinks?: boolean;
  trackScreenViews?: boolean;
  trackAttributes?: boolean;
  trackHashChanges?: boolean;
  sessionReplay?: SessionReplayOptions;
};

function toCamelCase(str: string) {
  return str.replace(/([-_][a-z])/gi, ($1) =>
    $1.toUpperCase().replace('-', '').replace('_', ''),
  );
}

type PendingRevenue = {
  amount: number;
  properties?: Record<string, unknown>;
};

export class OpenPanel extends OpenPanelBase {
  private lastPath = '';
  private debounceTimer: any;
  private pendingRevenues: PendingRevenue[] = [];
  /**
   * Client-owned session_id manager. Populated in constructor when running
   * in a browser context. Stays undefined server-side (SSR / Node).
   * See docs for the PostHog-style contract this implements.
   */
  private sessionManager?: SessionIdManager;

  /**
   * Client-generated window_id — unique per tab / per page-load. Generated
   * once in the constructor and never persisted, so:
   *   - Refresh in same tab → new window_id (new recording)
   *   - New tab → new window_id (independent recording)
   *   - Long-lived same tab → same window_id (contiguous recording)
   *
   * Included in every track event and every replay chunk. Chunk uniqueness
   * on the server is (project_id, session_id, window_id, chunk_index), so
   * multiple tabs / refreshes never collide on chunk_index.
   */
  private windowId?: string;

  /**
   * Unsubscribe for the session-rotation listener registered in
   * maybeStartReplay(). Captured so stopReplay() can detach it — otherwise a
   * later rotation would restart the recorder after a manual stop.
   */
  private replaySessionUnsub?: () => void;

  constructor(public options: OpenPanelOptions) {
    super({
      sdk: 'web',
      sdkVersion: process.env.WEB_VERSION!,
      ...options,
    });

    if (!this.isServer()) {
      // Own the session_id client-side. Every subsequent track/identify/replay
      // will attach the current session_id from this manager. Server no longer
      // has to derive one from (deviceId + Redis). Also fixes:
      //   - Bug 2 (stale closure): recorder is re-notified on idle rotation
      //   - Bug 3 (late start): session_id is available synchronously
      this.sessionManager = new SessionIdManager();
      this.sessionId = this.sessionManager.getSessionId();
      // Fresh window_id per SDK init — dies with the tab / page-load.
      this.windowId = this.newUuid();
      try {
        const pending = sessionStorage.getItem('openpanel-pending-revenues');
        if (pending) {
          const parsed = JSON.parse(pending);
          if (Array.isArray(parsed)) {
            this.pendingRevenues = parsed;
          }
        }
      } catch {
        this.pendingRevenues = [];
      }

      // Auto-generate a persistent deviceId in localStorage and send it
      // as `__deviceId` on every event. Without this, the server falls
      // back to `hash(salt + projectId + ip + user-agent)`, which collides
      // for every user behind the same NAT (office, home WiFi, mobile
      // carrier) — their sessions and replays get merged together.
      //
      // Consumers can override by calling
      //   op.setGlobalProperties({ __deviceId: someStableUserId })
      // after auth resolves (e.g. with a Firebase UID), which is strictly
      // better than the auto-generated UUID because it stitches the same
      // human across browsers / devices.
      const initialDeviceId = this.initLocalDeviceId();
      this.setGlobalProperties({
        __referrer: document.referrer,
        ...(initialDeviceId ? { __deviceId: initialDeviceId } : {}),
      });

      if (this.options.trackScreenViews) {
        this.trackScreenViews();
        setTimeout(() => this.screenView(), 0);
      }

      if (this.options.trackOutgoingLinks) {
        this.trackOutgoingLinks();
      }

      if (this.options.trackAttributes) {
        this.trackAttributes();
      }

      if (this.options.sessionReplay?.enabled) {
        this.maybeStartReplay();
      }
    }
  }

  /**
   * Storage key for the persistent client-side deviceId.
   *
   * Consumers can override by calling
   *   op.setGlobalProperties({ __deviceId: stableUserId })
   * after auth resolves. The override only affects new events emitted
   * after the call — events already in flight keep the localStorage id.
   */
  private static readonly LOCAL_DEVICE_ID_KEY = '_op_device_id';

  /**
   * Generate a v4 UUID. Uses `crypto.randomUUID()` where available
   * (modern browsers + secure contexts including http://localhost);
   * falls back to `Math.random` for older browsers and sandboxed
   * contexts where the Web Crypto API is unavailable. The fallback is
   * fine for an analytics identifier — we need collision-resistance, not
   * cryptographic unpredictability.
   */
  private newUuid(): string {
    try {
      if (
        typeof crypto !== 'undefined' &&
        typeof crypto.randomUUID === 'function'
      ) {
        return crypto.randomUUID();
      }
    } catch {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Read or create the persistent deviceId in localStorage, and stash it
   * on the base SDK so `fetchDeviceId` can pass it back to the server.
   *
   * Returns the deviceId, or null if browser storage is unavailable
   * (private mode quirks, sandboxed iframe, quota exhausted). In the
   * null case, the caller should NOT call `setGlobalProperties({ __deviceId })`
   * and the server falls back to its existing IP+UA derivation. This
   * gives us a clean backward-compat path with zero regression.
   */
  private initLocalDeviceId(): string | null {
    if (typeof window === 'undefined') return null;
    try {
      let deviceId = localStorage.getItem(OpenPanel.LOCAL_DEVICE_ID_KEY);
      if (!deviceId) {
        deviceId = this.newUuid();
        localStorage.setItem(OpenPanel.LOCAL_DEVICE_ID_KEY, deviceId);
      }
      // Stashed on the base SDK so `fetchDeviceId()` can pass it as a
      // query param to /track/device-id, getting back the correct
      // sessionId for this device.
      this.deviceId = deviceId;
      return deviceId;
    } catch {
      return null;
    }
  }

  private maybeStartReplay() {
    const opts = this.options.sessionReplay;
    if (!opts?.enabled) return;

    const sampleRate = opts.sampleRate ?? 1;
    if (Math.random() >= sampleRate) {
      this.log('replay sample miss, not recording');
      return;
    }

    // session_id is available synchronously now — no polling. The manager
    // read/created it in the constructor.
    if (!this.sessionManager || !this.sessionId) {
      this.log('replay: sessionManager unavailable, not starting recorder');
      return;
    }

    // Snapshot the id per recorder lifecycle. When SessionIdManager rotates
    // (30-min idle or 24-hr cap), we tear down the current recorder and
    // start a new one with the fresh id (chunk_index=0 + FullSnapshot).
    let activeSessionId = this.sessionId;
    const bumpActivity = () => this.sessionManager?.bumpActivity();
    // Shared recorder-start so the initial start and the post-rotation restart
    // stay in sync (single source of truth for the chunk-send closure).
    const startForSession = (sessionId: string) => {
      activeSessionId = sessionId;
      startReplayRecorder(
        opts,
        (chunk) => {
          this.send({
            type: 'replay',
            payload: {
              ...chunk,
              session_id: activeSessionId,
            },
          });
        },
        bumpActivity,
      );
    };

    startForSession(this.sessionId);

    this.replaySessionUnsub = this.sessionManager.onSessionIdChanged((newId) => {
      // Match PostHog: a session rotation also mints a fresh window_id. The
      // recorder restarts with a new FullSnapshot at chunk_index=0, so the
      // post-rotation recording is fully self-describing — the dashboard
      // groups by window_id and never stitches pre- and post-idle chunks
      // into one continuous timeline.
      this.windowId = this.newUuid();
      this.log('replay: session rotated, restarting recorder', {
        from: activeSessionId,
        to: newId,
        windowId: this.windowId,
      });
      this.sessionId = newId;
      stopReplayRecorder();
      startForSession(newId);
    });
  }

  public stopReplay() {
    // Detach the rotation listener first, so a later session rotation can't
    // restart the recorder after a manual stop.
    this.replaySessionUnsub?.();
    this.replaySessionUnsub = undefined;
    stopReplayRecorder();
  }

  /**
   * Every outbound payload flows through here. We use the entry point to:
   *   1. Let SessionIdManager decide whether to rotate (lazy check)
   *   2. Refresh `this.sessionId` so the base class carries the fresh value
   *   3. Stamp the fresh session_id onto non-replay payloads
   *   4. Bump last_activity so sibling tabs know this tab is alive
   *
   * Replay chunks are NOT restamped here — the recorder's callback closure
   * already tagged them with the session_id that was active at chunk
   * creation time. Overwriting with the current session_id would misfile
   * chunks recorded seconds before a rotation.
   */
  async send(payload: import('@openpanel/sdk').TrackHandlerPayload) {
    if (this.sessionManager) {
      const currentSessionId = this.sessionManager.getSessionId();
      this.sessionId = currentSessionId;
      // Only user-driven payloads count as activity. Replay chunks are NOT
      // activity — a backgrounded tab flushing chunks from background DOM
      // churn must not keep the session alive (that produced multi-hour ghost
      // recordings). Real user interactions bump activity via the recorder's
      // onUserActivity callback instead (see maybeStartReplay).
      if (payload.type !== 'replay') {
        this.sessionManager.bumpActivity();
      }

      if (payload.type === 'track' && payload.payload) {
        payload = {
          ...payload,
          payload: {
            ...payload.payload,
            session_id: currentSessionId,
            ...(this.windowId ? { window_id: this.windowId } : {}),
          },
        };
      } else if (payload.type === 'replay' && payload.payload) {
        // Replay chunk already carries session_id (stamped by the recorder
        // closure at buffer time). Only add window_id here — don't overwrite
        // session_id: chunks recorded before a rotation should stay under
        // the session_id that was active at recording time.
        payload = {
          ...payload,
          payload: {
            ...payload.payload,
            ...(this.windowId ? { window_id: this.windowId } : {}),
          },
        };
      }
    }
    return super.send(payload);
  }

  private debounce(func: () => void, delay: number) {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(func, delay);
  }

  private isServer() {
    return typeof document === 'undefined';
  }

  public trackOutgoingLinks() {
    if (this.isServer()) {
      return;
    }

    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const link = target.closest('a');
      if (link && target) {
        const href = link.getAttribute('href');
        if (href?.startsWith('http')) {
          try {
            const linkUrl = new URL(href);
            const currentHostname = window.location.hostname;
            if (linkUrl.hostname !== currentHostname) {
              super.track('link_out', {
                href,
                text:
                  link.innerText ||
                  link.getAttribute('title') ||
                  target.getAttribute('alt') ||
                  target.getAttribute('title'),
              });
            }
          } catch {
            // Invalid URL, skip tracking
          }
        }
      }
    });
  }

  public trackScreenViews() {
    if (this.isServer()) {
      return;
    }

    const oldPushState = history.pushState;
    history.pushState = function pushState(...args) {
      const ret = oldPushState.apply(this, args);
      window.dispatchEvent(new Event('pushstate'));
      window.dispatchEvent(new Event('locationchange'));
      return ret;
    };

    const oldReplaceState = history.replaceState;
    history.replaceState = function replaceState(...args) {
      const ret = oldReplaceState.apply(this, args);
      window.dispatchEvent(new Event('replacestate'));
      window.dispatchEvent(new Event('locationchange'));
      return ret;
    };

    window.addEventListener('popstate', () => {
      window.dispatchEvent(new Event('locationchange'));
    });

    const eventHandler = () => this.debounce(() => this.screenView(), 50);

    if (this.options.trackHashChanges) {
      window.addEventListener('hashchange', eventHandler);
    } else {
      window.addEventListener('locationchange', eventHandler);
    }
  }

  public trackAttributes() {
    if (this.isServer()) {
      return;
    }

    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const btn = target.closest('button');
      const anchor = target.closest('a');
      const element = btn?.getAttribute('data-track')
        ? btn
        : anchor?.getAttribute('data-track')
          ? anchor
          : null;
      if (element) {
        const properties: Record<string, unknown> = {};
        for (const attr of element.attributes) {
          if (attr.name.startsWith('data-') && attr.name !== 'data-track') {
            properties[toCamelCase(attr.name.replace(/^data-/, ''))] =
              attr.value;
          }
        }
        const name = element.getAttribute('data-track');
        if (name) {
          super.track(name, properties);
        }
      }
    });
  }

  screenView(properties?: TrackProperties): void;
  screenView(path: string, properties?: TrackProperties): void;
  screenView(
    pathOrProperties?: string | TrackProperties,
    propertiesOrUndefined?: TrackProperties,
  ): void {
    if (this.isServer()) {
      return;
    }

    let path: string;
    let properties: TrackProperties | undefined;

    if (typeof pathOrProperties === 'string') {
      path = pathOrProperties;
      properties = propertiesOrUndefined;
    } else {
      path = window.location.href;
      properties = pathOrProperties;
    }

    if (this.lastPath === path) {
      return;
    }

    this.lastPath = path;
    super.track('screen_view', {
      ...(properties ?? {}),
      __path: path,
      __title: document.title,
    });
  }

  async flushRevenue() {
    const promises = this.pendingRevenues.map((pending) =>
      super.revenue(pending.amount, pending.properties),
    );
    await Promise.all(promises);
    this.clearRevenue();
  }

  clearRevenue() {
    this.pendingRevenues = [];
    if (!this.isServer()) {
      try {
        sessionStorage.removeItem('openpanel-pending-revenues');
      } catch {}
    }
  }

  pendingRevenue(amount: number, properties?: Record<string, unknown>) {
    this.pendingRevenues.push({ amount, properties });
    if (!this.isServer()) {
      try {
        sessionStorage.setItem(
          'openpanel-pending-revenues',
          JSON.stringify(this.pendingRevenues),
        );
      } catch {}
    }
  }
}
