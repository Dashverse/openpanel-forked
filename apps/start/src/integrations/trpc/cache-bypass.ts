/**
 * Chart/funnel/conversion results are cached server-side in Redis (see
 * `cacheMiddleware` in @openpanel/trpc). The dashboard "Reload" button needs a
 * way to force a fresh recompute that also repopulates that cache.
 *
 * When the user hits Reload we open a short bypass window. Any tRPC request sent
 * while the window is open carries the `x-op-skip-cache` header, which tells the
 * server middleware to skip the cache read but still recompute + rewrite it.
 *
 * A time window (rather than per-query plumbing) keeps React Query keys stable
 * and reliably covers the charts that refetch after a Reload remounts them and
 * clears their cached data.
 */
let bypassUntil = 0;

export function openServerCacheBypassWindow(durationMs = 15_000): void {
  bypassUntil = Date.now() + durationMs;
}

export function shouldBypassServerCache(): boolean {
  return Date.now() < bypassUntil;
}
