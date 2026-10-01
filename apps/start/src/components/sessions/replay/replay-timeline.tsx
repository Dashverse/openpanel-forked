import { useCurrentTime, useReplayContext } from '@/components/sessions/replay/replay-context';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { IServiceEvent } from '@openpanel/db';
import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EventIcon } from '@/components/events/event-icon';
import { cn } from '@/utils/cn';
import { Loader2 } from 'lucide-react';
import {
  ReplayPlayPauseButton,
  ReplaySkipButton,
  ReplaySpeedControl,
  ReplaySpeedMenu,
  ReplayTime,
} from './replay-controls';
import { formatDuration, getEventOffsetMs } from './replay-utils';

export function ReplayTimeline({
  events,
  variant = 'default',
  trailing,
}: {
  events: IServiceEvent[];
  // 'studio' = Session Replays page layout (scrubber over a controls row).
  variant?: 'default' | 'studio';
  // Extra controls placed before the speed menu (studio only).
  trailing?: ReactNode;
}) {
  const studio = variant === 'studio';
  const {
    currentTimeRef,
    // Display (gap-collapsed) space — the scrubber renders in this so idle air
    // isn't shown. seek() still takes a wall-clock offset (fromDisplayMs).
    displayDuration,
    toDisplayMs,
    fromDisplayMs,
    segmentBoundariesMs,
    startTime,
    isReady,
    seek,
    subscribeToCurrentTime,
    loadedUpToMs,
    isBuffering,
  } = useReplayContext();
  // currentTime as React state is only needed for keyboard seeks (low frequency).
  // The progress bar and thumb are updated directly via DOM refs to avoid re-renders.
  const currentTime = useCurrentTime(250);
  const trackRef = useRef<HTMLDivElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverInfo, setHoverInfo] = useState<{
    pct: number;
    timeMs: number;
  } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const rafDragRef = useRef<number | null>(null);

  // Clean up any in-progress drag listeners when the component unmounts
  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  // Update progress bar and thumb directly via DOM on every tick — no React
  // re-render. currentTime is wall-clock; map it into display space.
  useEffect(() => {
    if (displayDuration <= 0) return;
    return subscribeToCurrentTime((t) => {
      const pct = Math.max(
        0,
        Math.min(100, (toDisplayMs(t) / displayDuration) * 100),
      );
      if (progressBarRef.current) {
        progressBarRef.current.style.width = `${pct}%`;
      }
      if (thumbRef.current) {
        thumbRef.current.style.left = `calc(${pct}% - 8px)`;
      }
    });
  }, [subscribeToCurrentTime, displayDuration, toDisplayMs]);

  // Map a click/hover X into both display ms (for the badge) and the wall-clock
  // ms that seek() needs (gaps collapsed → the two differ).
  const getTimeFromClientX = useCallback(
    (clientX: number) => {
      if (!trackRef.current || displayDuration <= 0) return null;
      const rect = trackRef.current.getBoundingClientRect();
      if (rect.width <= 0 || !Number.isFinite(rect.width)) {
        return null;
      }
      const x = clientX - rect.left;
      const pct = Math.max(0, Math.min(1, x / rect.width));
      const displayMs = pct * displayDuration;
      return { pct, displayMs, wallMs: fromDisplayMs(displayMs) };
    },
    [displayDuration, fromDisplayMs],
  );

  const handleTrackMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest('[data-timeline-event]')) {
        setHoverInfo(null);
        return;
      }
      const info = getTimeFromClientX(e.clientX);
      if (info) setHoverInfo({ pct: info.pct, timeMs: info.displayMs });
    },
    [getTimeFromClientX],
  );

  const handleTrackMouseLeave = useCallback(() => {
    if (!isDragging) setHoverInfo(null);
  }, [isDragging]);

  const handleTrackMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only handle direct clicks on the track, not on child elements like the thumb
      if (
        e.target !== trackRef.current &&
        !(e.target as HTMLElement).closest('.replay-track-bg')
      )
        return;
      const info = getTimeFromClientX(e.clientX);
      if (info) seek(info.wallMs);
    },
    [getTimeFromClientX, seek],
  );

  // Each event carries both its wall-clock offset (for seek) and its display
  // (gap-collapsed) offset (for positioning on the scrubber).
  const eventsWithOffset = useMemo(
    () =>
      events
        .map((ev) => {
          const wallOffsetMs =
            startTime != null ? getEventOffsetMs(ev, startTime) : 0;
          return {
            event: ev,
            wallOffsetMs,
            offsetMs: toDisplayMs(wallOffsetMs),
          };
        })
        .filter(
          ({ offsetMs, wallOffsetMs }) =>
            wallOffsetMs >= 0 && offsetMs >= 0 && offsetMs <= displayDuration,
        ),
    [events, startTime, displayDuration, toDisplayMs],
  );

  // Group events that are within 24px of each other on the track (display space).
  const groupedEvents = useMemo(() => {
    if (!eventsWithOffset.length || displayDuration <= 0) return [];

    // Sort by display offset so we sweep left-to-right
    const sorted = [...eventsWithOffset].sort((a, b) => a.offsetMs - b.offsetMs);

    // 24px in ms — recalculated from container width; fall back to 2% of duration
    const trackWidth = trackRef.current?.offsetWidth ?? 600;
    // Icons need ~24px apart; studio ticks only ~6px.
    const thresholdMs = ((studio ? 6 : 24) / trackWidth) * displayDuration;

    const groups: { items: typeof sorted; pct: number }[] = [];
    for (const item of sorted) {
      const last = groups[groups.length - 1];
      const thisPct = (item.offsetMs / displayDuration) * 100;

      if (
        last &&
        item.offsetMs - last.items[last.items.length - 1]!.offsetMs <=
          thresholdMs
      ) {
        last.items.push(item);
        // Anchor the group at its first item's position
      } else {
        groups.push({ items: [item], pct: thisPct });
      }
    }

    return groups;
  }, [eventsWithOffset, displayDuration, studio]);

  if (!isReady || displayDuration <= 0) {
    // Studio keeps the bar's footprint while the player boots, so the layout
    // doesn't jump when playback becomes available.
    return studio ? <StudioControlsPlaceholder /> : null;
  }

  const progressPct = Math.max(
    0,
    Math.min(100, (toDisplayMs(currentTimeRef.current) / displayDuration) * 100),
  );
  const bufferedPct = Math.max(
    0,
    Math.min(100, (toDisplayMs(loadedUpToMs) / displayDuration) * 100),
  );

  const scrubber = (
        <div className={cn('relative', studio ? 'w-full' : 'col gap-4 flex-1 px-2')}>
          <AnimatePresence>
            {isBuffering && (
              <motion.div
                key="buffering"
                className="pointer-events-none absolute inset-0 z-30 row items-center justify-center gap-2 rounded bg-background/80 text-xs text-muted-foreground"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Buffering…</span>
              </motion.div>
            )}
          </AnimatePresence>
          <div
            ref={trackRef}
            role="slider"
            aria-valuemin={0}
            aria-valuemax={displayDuration}
            aria-valuenow={toDisplayMs(currentTime)}
            tabIndex={0}
            className="relative flex h-8 cursor-pointer items-center outline-0"
            onMouseDown={handleTrackMouseDown}
            onMouseMove={handleTrackMouseMove}
            onMouseLeave={handleTrackMouseLeave}
            onKeyDown={(e) => {
              const step = 5000;
              if (e.key === 'ArrowLeft') {
                e.preventDefault();
                seek(Math.max(0, currentTime - step));
              } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                seek(currentTime + step);
              }
            }}
          >
            <div className="replay-track-bg bg-muted relative h-1.5 w-full overflow-hidden rounded-full">
              {/* Buffered region — YouTube-style lighter bar showing how far chunks have loaded */}
              <div
                className="bg-primary/30 absolute left-0 top-0 h-full rounded-full"
                style={{ width: `${bufferedPct}%` }}
                aria-hidden
              />
              <div
                ref={progressBarRef}
                className="bg-primary relative h-full rounded-full"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            {/* Collapsed-idle markers — a thin notch where an idle gap was
             * removed, so the jump in real time is visible (PostHog-style). */}
            {segmentBoundariesMs.map((ms) => {
              const pct = (ms / displayDuration) * 100;
              return (
                <div
                  key={ms}
                  className="pointer-events-none absolute top-1/2 z-[4] h-3 w-px -translate-y-1/2 bg-foreground/25"
                  style={{ left: `${pct}%` }}
                  aria-hidden
                />
              );
            })}
            <div
              ref={thumbRef}
              className="absolute left-0 top-1/2 z-10 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow-sm"
              style={{ left: `calc(${progressPct}% - 8px)` }}
              aria-hidden
            />
            {/* Hover timestamp tooltip */}
            <AnimatePresence>
              {hoverInfo && (
                <motion.div
                  className="pointer-events-none absolute z-20"
                  style={{
                    left: `${hoverInfo.pct * 100}%`,
                    top: 0,
                    bottom: 0,
                  }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  {/* Vertical line */}
                  <div className="absolute left-0 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-foreground/30" />
                  {/* Timestamp badge */}
                  <motion.div
                    className="absolute bottom-6 left-1/2 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-[10px] tabular-nums text-background shadow"
                    initial={{ opacity: 0, y: 16, scale: 0.5 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 16, scale: 0.5 }}
                    transition={{ duration: 0.2 }}
                  >
                    {formatDuration(hoverInfo.timeMs)}
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
            {groupedEvents.map((group) => {
              const first = group.items[0]!;
              const isGroup = group.items.length > 1;
              return (
                <Tooltip key={first.event.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-timeline-event
                      className={cn(
                        'absolute top-1/2 z-[5] flex -translate-y-1/2 items-center justify-center',
                        studio
                          ? // Studio: a thin tick with a wider hit area — dozens of
                            // icon bubbles would bury the track on busy sessions.
                            'group h-5 w-3 -translate-x-1/2'
                          : 'h-6 w-6 transition-transform hover:scale-105',
                      )}
                      style={
                        studio
                          ? { left: `${group.pct}%` }
                          : { left: `${group.pct}%`, marginLeft: -12 }
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        // Seek uses the wall-clock offset, not the display one.
                        seek(first.wallOffsetMs);
                      }}
                      aria-label={isGroup ? `${group.items.length} events at ${formatDuration(first.offsetMs)}` : `${first.event.name} at ${formatDuration(first.offsetMs)}`}
                    >
                      {studio ? (
                        <span
                          className={cn(
                            'block w-0.5 rounded-full bg-foreground/35 transition-colors group-hover:bg-primary',
                            isGroup ? 'h-3.5' : 'h-2.5',
                          )}
                        />
                      ) : (
                        <EventIcon name={first.event.name} meta={first.event.meta} size="sm" />
                      )}
                      {!studio && isGroup && (
                        <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-[9px] font-bold leading-none text-background">
                          {group.items.length}
                        </span>
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="col gap-1.5">
                    {group.items.slice(0, 8).map(({ event: ev, offsetMs }) => (
                      <div key={ev.id} className="row items-center gap-2">
                        <EventIcon name={ev.name} meta={ev.meta} size="sm" />
                        <span className="font-medium">
                          {ev.name === 'screen_view' ? ev.path : ev.name}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          {formatDuration(offsetMs)}
                        </span>
                      </div>
                    ))}
                    {group.items.length > 8 && (
                      <span className="text-muted-foreground">
                        +{group.items.length - 8} more
                      </span>
                    )}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
  );

  if (studio) {
    // Mixpanel-style: full-width scrubber on top, transport + options below.
    return (
      <TooltipProvider delayDuration={300}>
        <div className="col gap-1 border-t bg-background px-4 pb-2 pt-2">
          {scrubber}
          <div className="row flex-wrap items-center gap-1">
            <ReplayPlayPauseButton />
            <ReplaySkipButton direction="back" />
            <ReplaySkipButton direction="forward" />
            <div className="ml-2">
              <ReplayTime />
            </div>
            <div className="flex-1" />
            {trailing}
            <ReplaySpeedMenu />
          </div>
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="row items-center gap-4 p-4">
        <ReplayPlayPauseButton />
        <ReplaySpeedControl />
        {scrubber}
      </div>
    </TooltipProvider>
  );
}

/** Inert copy of the studio control bar shown while the player loads. */
function StudioControlsPlaceholder() {
  return (
    <div
      className="col gap-1 border-t bg-background px-4 pb-2 pt-2"
      aria-hidden
    >
      <div className="flex h-8 items-center">
        <div className="h-1.5 w-full animate-pulse rounded-full bg-muted" />
      </div>
      <div className="row h-9 items-center gap-2">
        <div className="size-8 animate-pulse rounded-md bg-muted" />
        <div className="size-8 rounded-md bg-muted/60" />
        <div className="size-8 rounded-md bg-muted/60" />
        <div className="ml-2 h-4 w-24 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}
