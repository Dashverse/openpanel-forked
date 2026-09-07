import { useCurrentTime, useReplayContext } from '@/components/sessions/replay/replay-context';
import { ReplayEventItem } from '@/components/sessions/replay/replay-event-item';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { IServiceEvent } from '@openpanel/db';
import { ArrowDownToLine } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserChrome } from './browser-chrome';
import { getEventOffsetMs } from './replay-utils';

type EventWithOffset = { event: IServiceEvent; offsetMs: number };

export function ReplayEventFeed({ events, replayLoading }: { events: IServiceEvent[]; replayLoading: boolean }) {
  const { startTime, isReady, seek } = useReplayContext();
  const currentTime = useCurrentTime(100);
  const scrollRootRef = useRef<HTMLDivElement | null>(null);

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
  // Highlight target: the event at/under the playhead (null before playback has
  // passed the first event — nothing highlighted yet).
  const currentEventId = sortedEvents[currentIndex]?.event.id ?? null;
  // Follow/scroll target: same, but falls back to the first event so "follow"
  // and the "Jump to current" pill work even at 0:00 before play.
  const followTargetId =
    sortedEvents[Math.max(0, currentIndex)]?.event.id ?? null;
  const currentRowRef = useRef<HTMLDivElement | null>(null);

  // "Follow the playhead": auto-scroll the current event into view as playback
  // advances. But the MOMENT the user scrolls away we STOP following (otherwise
  // every tick yanks them back), and show a "Jump to current" pill to resume.
  // Follow auto-resumes if they scroll the current row back into view.
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  // scrollIntoView fires scroll events too — flag our own scrolls so the scroll
  // listener doesn't mistake them for the user taking control.
  const programmaticRef = useRef(false);

  const setFollow = useCallback((v: boolean) => {
    followingRef.current = v;
    setFollowing(v);
  }, []);

  // Is the current row fully within the scroll viewport right now?
  // NOTE: <ScrollArea ref> forwards straight to the Radix Viewport, so
  // scrollRootRef.current IS the scrollable element.
  const currentRowVisible = useCallback(() => {
    const el = currentRowRef.current;
    const vp = scrollRootRef.current;
    if (!el || !vp) return false;
    const er = el.getBoundingClientRect();
    const vr = vp.getBoundingClientRect();
    return er.top >= vr.top && er.bottom <= vr.bottom;
  }, []);

  const scrollToCurrent = useCallback((block: ScrollLogicalPosition) => {
    const el = currentRowRef.current;
    if (!el) return;
    programmaticRef.current = true;
    el.scrollIntoView({ block, behavior: 'smooth' });
    // Release the flag after the smooth scroll settles.
    window.setTimeout(() => {
      programmaticRef.current = false;
    }, 400);
  }, []);

  // Detect manual scroll on the viewport → drop out of follow (or rejoin if the
  // current row is back in view). <ScrollArea ref> IS the scrollable Viewport.
  useEffect(() => {
    const vp = scrollRootRef.current;
    if (!vp) return;
    const onScroll = () => {
      if (programmaticRef.current) return; // our own scrollIntoView, ignore
      if (currentRowVisible()) {
        if (!followingRef.current) setFollow(true);
      } else if (followingRef.current) {
        setFollow(false);
      }
    };
    vp.addEventListener('scroll', onScroll, { passive: true });
    return () => vp.removeEventListener('scroll', onScroll);
  }, [currentRowVisible, setFollow]);

  // Keep the current event in view as playback advances — but only while
  // following (block: 'nearest' only scrolls when it's actually off-screen).
  useEffect(() => {
    if (!followingRef.current) return;
    scrollToCurrent('nearest');
  }, [followTargetId, scrollToCurrent]);

  const jumpToCurrent = useCallback(() => {
    setFollow(true);
    scrollToCurrent('center');
  }, [setFollow, scrollToCurrent]);

  return (
    <BrowserChrome
      url={false}
      controls={<span className="text-lg font-medium">Timeline</span>}
      className="h-full"
    >
      <div className="relative flex-1 min-h-0">
        <ScrollArea className="h-full" ref={scrollRootRef}>
          <div className="flex w-full flex-col">
            {sortedEvents.map(({ event, offsetMs }) => {
              const isCurrent = event.id === currentEventId;
              // The ref tracks the follow target (falls back to first event) so
              // scroll/pill work before playback; highlight tracks currentEventId.
              const isFollowTarget = event.id === followTargetId;
              return (
                <div
                  key={event.id}
                  ref={isFollowTarget ? currentRowRef : undefined}
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

        {/* "Jump to current" pill — appears only when the user has scrolled away
         * from the playhead. Clicking re-enables follow and recenters. */}
        {!following && followTargetId && (
          <button
            type="button"
            onClick={jumpToCurrent}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-xs font-medium shadow-md hover:bg-muted"
          >
            <ArrowDownToLine className="size-3.5" />
            Jump to current
          </button>
        )}
      </div>
    </BrowserChrome>
  );
}
