/**
 * Safe wrappers around localStorage and sessionStorage.
 *
 * Both may be unavailable in some contexts:
 *   - server-side (typeof window === 'undefined')
 *   - sandboxed iframes (no storage APIs)
 *   - private-mode Safari (throws QuotaExceededError on first write in some versions)
 *   - user disabled cookies / storage
 *   - quota exhausted
 *
 * Every operation returns a defined "not-available" result rather than throwing,
 * so callers can no-op cleanly without try/catch at every call site.
 *
 * Distinction:
 *   - localStorage:   shared across all tabs of the same origin, persists across
 *                     sessions. Used for _op_session_id + _op_last_activity_ms
 *                     so cross-tab activity is visible to all tabs.
 *   - sessionStorage: per-tab, dies when the tab closes. Used for _op_window_id
 *                     so each tab gets a unique window scope.
 */

type StorageBackend = {
  get(key: string): string | null;
  set(key: string, value: string): boolean;
  remove(key: string): void;
  isAvailable(): boolean;
};

function createBackend(
  getStore: () => Storage | undefined,
): StorageBackend {
  return {
    get(key) {
      try {
        return getStore()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        getStore()?.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        getStore()?.removeItem(key);
      } catch {
        // no-op
      }
    },
    isAvailable() {
      try {
        const store = getStore();
        if (!store) return false;
        const probe = '__op_storage_probe__';
        store.setItem(probe, '1');
        store.removeItem(probe);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export const localStore = createBackend(() =>
  typeof window !== 'undefined' ? window.localStorage : undefined,
);

export const sessionStore = createBackend(() =>
  typeof window !== 'undefined' ? window.sessionStorage : undefined,
);
