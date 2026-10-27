import type { IServiceEvent } from '@openpanel/db';

export function getEventOffsetMs(
  event: IServiceEvent,
  startTime: number,
): number {
  const t =
    typeof event.createdAt === 'object' && event.createdAt instanceof Date
      ? event.createdAt.getTime()
      : new Date(event.createdAt).getTime();
  return t - startTime;
}

/** Format a duration in milliseconds as M:SS, or H:MM:SS from one hour up. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}

type WindowActivity = { windowId: string; activeDurationMs: number };

/**
 * The tab (window) to play when the user/link chose none. Keeps `pinnedId`
 * while that tab is still listed: a live session's block list is refetched
 * on an interval, and another live tab overtaking it in active time must not
 * remount the player mid-watch. Otherwise (first resolve, or the pinned tab
 * vanished) it is the tab with the most recorded (active) time, since the
 * earliest one is often a 0-2 s stub (redirect / quick reload).
 */
export function resolveDefaultWindowId(
  windows: WindowActivity[],
  pinnedId: string | null,
): string | null {
  if (windows.length === 0) return null;
  if (pinnedId !== null && windows.some((w) => w.windowId === pinnedId)) {
    return pinnedId;
  }
  return windows.reduce((best, w) =>
    w.activeDurationMs > best.activeDurationMs ? w : best,
  ).windowId;
}

/**
 * The tab actually played: the explicit selection (URL link or user click)
 * while it exists, else the default. Before the list has loaded the
 * selection is trusted as is; a stale linked tab falls back to the default.
 */
export function resolveActiveWindowId(input: {
  selectedId: string | null;
  defaultId: string | null;
  windows: WindowActivity[];
  listLoaded: boolean;
}): string | null {
  const { selectedId, defaultId, windows, listLoaded } = input;
  if (
    selectedId !== null &&
    (!listLoaded || windows.some((w) => w.windowId === selectedId))
  ) {
    return selectedId;
  }
  return defaultId;
}
