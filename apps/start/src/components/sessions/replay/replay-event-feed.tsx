import { useCurrentTime, useReplayContext } from '@/components/sessions/replay/replay-context';
import { ReplayEventItem } from '@/components/sessions/replay/replay-event-item';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { IServiceEvent } from '@openpanel/db';
import { useEffect, useMemo, useRef } from 'react';
import { BrowserChrome } from './browser-chrome';
import { getEventOffsetMs } from './replay-utils';

type EventWithOffset = { event: IServiceEvent; offsetMs: number };

export function ReplayEventFeed({ events, replayLoading }: { events: IServiceEvent[]; replayLoading: boolean }) {
  const { startTime, isReady, seek } = useReplayContext();
  const currentTime = useCurrentTime(100);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Pre-sort events by offset once when events/startTime changes.
  // This is the expensive part — done once, not on every tick.
  const sortedEvents = useMemo<EventWithOffset[]>(() => {
    if (startTime == null || !isReady) return [];
    return events
      .map((ev) => ({ event: ev, offsetMs: getEventOffsetMs(ev, startTime) }))
      .filter(({ offsetMs }) => offsetMs >= -10_000)
      .sort((a, b) => a.offsetMs - b.offsetMs);
  }, [events, startTime, isReady]);

  // Binary search to find how many events are visible at currentTime.
  // O(log n) instead of O(n) filter on every tick.
  const visibleCount = useMemo(() => {
    let lo = 0;
    let hi = sortedEvents.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((sortedEvents[mid]?.offsetMs ?? 0) <= currentTime) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }, [sortedEvents, currentTime]);

  // Show the WHOLE journey up front (PostHog-style): every event stays visible
  // and clickable so you can jump forward — not just events up to the playhead.
  // `currentIndex` (last event at/under the current time) drives the highlight +
  // auto-scroll only.
  const currentIndex = visibleCount - 1;
  const currentEventId = sortedEvents[currentIndex]?.event.id ?? null;
  const currentRowRef = useRef<HTMLDivElement | null>(null);

  // Keep the current event in view as playback advances (block: 'nearest' only
  // scrolls when it's actually off-screen, so it rarely fights manual scrolling).
  useEffect(() => {
    currentRowRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [currentEventId]);

  return (
    <BrowserChrome
      url={false}
      controls={<span className="text-lg font-medium">Timeline</span>}
      className="h-full"
    >
      <ScrollArea className="flex-1 min-h-0" ref={viewportRef}>
        <div className="flex w-full flex-col">
          {sortedEvents.map(({ event, offsetMs }) => {
            const isCurrent = event.id === currentEventId;
            return (
              <div
                key={event.id}
                ref={isCurrent ? currentRowRef : undefined}
                className="min-w-0"
              >
                <ReplayEventItem
                  event={event}
                  isCurrent={isCurrent}
                  // Seek to 1s BEFORE the event (PostHog) so you see the lead-up.
                  onClick={() => seek(Math.max(0, offsetMs - 1000))}
                />
              </div>
            );
          })}
          {!replayLoading && sortedEvents.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No events in this recording.
            </div>
          )}
          {replayLoading &&
            Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-2 border-b px-3 py-2"
              >
                <div className="h-6 w-6 shrink-0 animate-pulse rounded-full bg-muted" />
                <div className="flex-1 space-y-1.5">
                  <div
                    className="h-3 animate-pulse rounded bg-muted"
                    style={{ width: `${50 + (i % 4) * 12}%` }}
                  />
                </div>
                <div className="h-3 w-10 shrink-0 animate-pulse rounded bg-muted" />
              </div>
            ))}

        </div>
      </ScrollArea>
    </BrowserChrome>
  );
}
