import type { IServiceEvent } from '@openpanel/db';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FastForwardIcon, Maximize2, Minimize2 } from 'lucide-react';
import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserChrome } from './browser-chrome';
import { ReplayTime } from './replay-controls';
import { ReplayTimeline } from './replay-timeline';
import { formatDuration, getEventOffsetMs } from './replay-utils';
import {
  ReplayProvider,
  useCurrentTime,
  useReplayContext,
} from '@/components/sessions/replay/replay-context';
import { ReplayEventFeed } from '@/components/sessions/replay/replay-event-feed';
import { ReplayPlayer } from '@/components/sessions/replay/replay-player';
import { useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';

function BrowserUrlBar({ events }: { events: IServiceEvent[] }) {
  const { startTime } = useReplayContext();
  const currentTime = useCurrentTime(250);

  const currentUrl = useMemo(() => {
    if (startTime == null || !events.length) {
      return '';
    }

    const withOffset = events
      .map((ev) => ({
        event: ev,
        offsetMs: getEventOffsetMs(ev, startTime),
      }))
      .filter(({ offsetMs }) => offsetMs >= -10_000 && offsetMs <= currentTime)
      .sort((a, b) => a.offsetMs - b.offsetMs);

    const latest = withOffset.at(-1);
    if (!latest) {
      return '';
    }

    const { origin = '', path = '/' } = latest.event;
    return `${origin}${path}`;
  }, [events, currentTime, startTime]);

  return <span className="truncate text-muted-foreground">{currentUrl}</span>;
}

/**
 * Feeds remaining chunks into the player after it's ready.
 * Receives already-fetched chunks from the initial batch, then pages
 * through the rest using replayChunksFrom. Each chunk goes through
 * markChunkLoaded so the buffer (used by the buffer-aware seek path) stays
 * in sync.
 */
function ReplayChunkLoader({
  sessionId,
  projectId,
  fromIndex,
  windowId,
}: {
  sessionId: string;
  projectId: string;
  fromIndex: number;
  windowId?: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { markChunkLoaded } = useReplayContext();

  useEffect(() => {
    let cancelled = false;
    function recursive(fromIndex: number) {
      queryClient
        .fetchQuery(
          trpc.session.replayChunksFrom.queryOptions({
            sessionId,
            projectId,
            fromIndex,
            windowId,
          }),
        )
        .then((res) => {
          if (cancelled) return;
          res.data.forEach((row) => {
            if (!row) return;
            markChunkLoaded({
              chunkIndex: row.chunkIndex,
              startedAtMs: row.startedAtMs,
              endedAtMs: row.endedAtMs,
              events: row.events ?? [],
            });
          });
          if (res.hasMore) {
            recursive(fromIndex + res.data.length);
          }
        })
        .catch(() => {
          // chunk loading failed — replay may be incomplete
        });
    }

    recursive(fromIndex);
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}

function FullscreenButton({
  containerRef,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = useCallback(() => {
    if (!containerRef.current) {
      return;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      containerRef.current.requestFullscreen();
    }
  }, [containerRef]);

  return (
    <button
      aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
      onClick={toggle}
      type="button"
    >
      {isFullscreen ? (
        <Minimize2 className="h-3.5 w-3.5" />
      ) : (
        <Maximize2 className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

/**
 * Inside the provider, seed the buffer with first-batch chunks (events already
 * passed to rrweb at construction — no addToPlayer) and register the prefetch
 * function so the buffer-aware seek path can fetch chunks on demand.
 */
function ReplayBufferBootstrap({
  sessionId,
  projectId,
  firstBatch,
  windowId,
}: {
  sessionId: string;
  projectId: string;
  firstBatch: { chunkIndex: number; startedAtMs: number; endedAtMs: number; events: { type: number; data: unknown; timestamp: number }[] }[];
  windowId?: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { markChunkLoaded, setPrefetchChunks, setSeekFetch, isReady } =
    useReplayContext();

  // Seed the buffer once the player is ready (so duration recompute uses the
  // real rrweb metadata, not 0).
  useEffect(() => {
    if (!isReady || firstBatch.length === 0) return;
    for (const row of firstBatch) {
      markChunkLoaded(row, { addToPlayer: false });
    }
  }, [isReady, firstBatch, markChunkLoaded]);

  // Register the prefetch function that the seek slow-path calls.
  useEffect(() => {
    setPrefetchChunks(async (fromIndex, toIndex) => {
      const res = await queryClient.fetchQuery(
        trpc.session.replayChunksByIndexRange.queryOptions({
          sessionId,
          projectId,
          fromIndex,
          toIndex,
          windowId,
        }),
      );
      return res.data.map((row) => ({
        chunkIndex: row.chunkIndex,
        startedAtMs: row.startedAtMs,
        endedAtMs: row.endedAtMs,
        events: row.events ?? [],
      }));
    });
    return () => setPrefetchChunks(null);
  }, [sessionId, projectId, windowId, queryClient, trpc, setPrefetchChunks]);

  // Register the smart-seek fetcher. Used by seek() to jump to the latest
  // full DOM snapshot before the target time — one round trip, no walking.
  useEffect(() => {
    setSeekFetch(async (targetMs) => {
      const res = await queryClient.fetchQuery(
        trpc.session.replayChunksAroundTime.queryOptions({
          sessionId,
          projectId,
          targetMs,
          windowId,
        }),
      );
      return res.data.map((row) => ({
        chunkIndex: row.chunkIndex,
        startedAtMs: row.startedAtMs,
        endedAtMs: row.endedAtMs,
        events: row.events ?? [],
      }));
    });
    return () => setSeekFetch(null);
  }, [sessionId, projectId, windowId, queryClient, trpc, setSeekFetch]);

  return null;
}

export type ReplaySeekControls = { seekToWallMs: (wallMs: number) => void };

/**
 * Bridges the player's seek out to consumers (the Session Replays event list),
 * so clicking an event can jump the player to that timestamp. Must render
 * inside <ReplayProvider>.
 */
function SeekBridge({
  controlsRef,
}: {
  controlsRef?: MutableRefObject<ReplaySeekControls | null>;
}) {
  const { seek, startTime } = useReplayContext();
  useEffect(() => {
    if (!controlsRef) return;
    controlsRef.current = {
      seekToWallMs: (wallMs: number) => {
        if (startTime == null) return;
        seek(Math.max(0, wallMs - startTime));
      },
    };
    return () => {
      if (controlsRef) controlsRef.current = null;
    };
  }, [seek, startTime, controlsRef]);
  return null;
}

function ReplayContent({
  sessionId,
  projectId,
  windowId,
  windowDurationMs,
  showEventFeed = true,
  controlsRef,
}: {
  sessionId: string;
  projectId: string;
  // When set, only this recorder's (tab's) chunks are loaded — keeps
  // multi-tab sessions playable. undefined = legacy behaviour (all chunks).
  windowId?: string;
  // Per-window duration from the windows list. Overrides the session-wide
  // replayMeta duration so the timeline matches the selected recording.
  windowDurationMs?: number;
  // When false, render the player full-width without the side event feed.
  // Used by the Session Replays tab, which keeps events in its own left list.
  showEventFeed?: boolean;
  // Populated with the player's seek controls so external UIs (the replays
  // event list) can jump the player to an event's timestamp.
  controlsRef?: MutableRefObject<ReplaySeekControls | null>;
}) {
  const trpc = useTRPC();
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: eventsData } = useQuery(
    trpc.event.events.queryOptions({
      projectId,
      sessionId,
      filters: [],
      // Request window_id so the feed can scope events to the current tab
      // (with an empty-string fallback for backend / pre-window_id events).
      columnVisibility: { windowId: true },
    })
  );

  // Fetch first batch of chunks (includes chunk 0 for player init + more)
  const { data: firstBatch, isLoading: replayLoading } = useQuery(
    trpc.session.replayChunksFrom.queryOptions({
      sessionId,
      projectId,
      fromIndex: 0,
      windowId,
    })
  );

  // Definitive replay duration. One cheap min/max query — shown as the
  // canonical timeline length from first paint instead of rrweb's progressive
  // totalTime that grows as chunks load.
  const { data: replayMeta } = useQuery(
    trpc.session.replayMeta.queryOptions({ sessionId, projectId }),
  );

  // Scope events to the tab (window) being played. Events with an empty
  // window_id — backend events, and every event in a pre-window_id (legacy)
  // session — always show. That empty-string arm IS the fallback: a legacy
  // session has windowId=undefined and all events '' → the filter is a no-op
  // and you get today's session-wide, timestamp-ordered behaviour.
  const events = (eventsData?.data ?? []).filter(
    (e) => !windowId || !e.windowId || e.windowId === windowId,
  );
  // Memoize the flat events array so its identity is stable across re-renders
  // (replayMeta landing, buffering state flipping, etc.) — otherwise rrweb's
  // useEffect would tear down and recreate the player on every parent render,
  // visibly resetting playback to 0:00.
  const playerEvents = useMemo(
    () => firstBatch?.data.flatMap((row) => row?.events ?? []) ?? [],
    [firstBatch],
  );
  // Stable reference for the same reason — passed into ReplayBufferBootstrap.
  const firstBatchData = useMemo(
    () => firstBatch?.data ?? [],
    [firstBatch],
  );
  const hasMore = firstBatch?.hasMore ?? false;
  const hasReplay = playerEvents.length !== 0;
  // Skip idle periods by default — a mostly-idle recording plays through in
  // its seconds of real activity instead of frozen minutes. User-toggleable.
  const [skipInactive, setSkipInactive] = useState(true);

  function renderReplay() {
    // On the Session Replays tab (showEventFeed=false) the loading + empty
    // states use the same dark, tall box as the player, so the UI doesn't jump
    // (small light box → big dark player) once chunks arrive. On the session
    // detail page they stay compact.
    const placeholder = showEventFeed
      ? 'h-[320px] bg-background'
      : 'h-[calc(100vh-11rem)] bg-neutral-950';
    if (replayLoading) {
      return (
        <div
          className={cn(
            'flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground',
            placeholder,
          )}
        >
          <div className="size-8 animate-pulse rounded-full bg-muted" />
          Loading session replay…
        </div>
      );
    }
    if (hasReplay) {
      return <ReplayPlayer events={playerEvents} skipInactive={skipInactive} />;
    }
    return (
      <div
        className={cn(
          'flex items-center justify-center text-sm text-muted-foreground',
          placeholder,
        )}
      >
        No replay data available for this session.
      </div>
    );
  }

  return (
    <ReplayProvider
      totalDurationMs={windowDurationMs ?? replayMeta?.totalDurationMs}
    >
      <SeekBridge controlsRef={controlsRef} />
      <div
        className={cn(
          'grid gap-4 [&:fullscreen]:flex [&:fullscreen]:flex-col [&:fullscreen]:bg-background [&:fullscreen]:p-4',
          showEventFeed ? 'lg:grid-cols-[1fr_380px]' : 'grid-cols-1',
        )}
        id="replay"
        ref={containerRef}
      >
        <div className="flex min-w-0 flex-col overflow-hidden">
          <BrowserChrome
            right={
              <div className="flex items-center gap-2">
                {hasReplay && <ReplayTime />}
                {hasReplay && (
                  <button
                    type="button"
                    aria-pressed={skipInactive}
                    onClick={() => setSkipInactive((v) => !v)}
                    title={
                      skipInactive
                        ? 'Skipping inactivity — click to play idle periods too'
                        : 'Playing everything — click to skip idle periods'
                    }
                    className={
                      skipInactive
                        ? 'flex items-center gap-1 rounded border border-primary bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary'
                        : 'flex items-center gap-1 rounded border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground'
                    }
                  >
                    <FastForwardIcon className="size-3" />
                    Skip idle
                  </button>
                )}
                <FullscreenButton containerRef={containerRef} />
              </div>
            }
            url={
              hasReplay ? (
                <BrowserUrlBar events={events} />
              ) : (
                <span className="text-muted-foreground">about:blank</span>
              )
            }
          >
            {renderReplay()}
            {hasReplay && <ReplayTimeline events={events} />}
          </BrowserChrome>
        </div>
        {showEventFeed && (
          <div className="relative hidden lg:block">
            <div className="absolute inset-0">
              <ReplayEventFeed events={events} replayLoading={replayLoading} />
            </div>
          </div>
        )}
      </div>
      {hasReplay && (
        <ReplayBufferBootstrap
          firstBatch={firstBatchData}
          projectId={projectId}
          sessionId={sessionId}
          windowId={windowId}
        />
      )}
      {hasReplay && hasMore && (
        <ReplayChunkLoader
          fromIndex={firstBatch?.data?.length ?? 0}
          projectId={projectId}
          sessionId={sessionId}
          windowId={windowId}
        />
      )}
    </ReplayProvider>
  );
}

export function ReplayShell({
  sessionId,
  projectId,
  showEventFeed = true,
  tabsOnRight = false,
  controlsRef,
}: {
  sessionId: string;
  projectId: string;
  showEventFeed?: boolean;
  // When true (Session Replays tab), the multi-window switcher renders as a
  // vertical column to the RIGHT of the player instead of a row on top.
  tabsOnRight?: boolean;
  controlsRef?: MutableRefObject<ReplaySeekControls | null>;
}) {
  const trpc = useTRPC();
  const [selectedWindowId, setSelectedWindowId] = useState<string | null>(null);

  // List the distinct recorders (tabs) that wrote to this session. Each is a
  // separate rrweb recording — the player must play one at a time to avoid
  // mixing DOM mirror states across concurrent tabs.
  const { data: windows } = useQuery(
    trpc.session.replayWindows.queryOptions({ sessionId, projectId }),
  );

  const hasWindows = (windows?.length ?? 0) > 0;
  const multiWindow = (windows?.length ?? 0) > 1;

  // Default to the first (earliest) window once the list loads.
  const activeWindowId =
    selectedWindowId ?? (hasWindows ? windows![0]!.windowId : null);
  const activeWindow = windows?.find((w) => w.windowId === activeWindowId);

  const windowButtons = multiWindow
    ? windows!.map((w, i) => {
        const isActive = w.windowId === activeWindowId;
        return (
          <button
            key={w.windowId || 'legacy'}
            type="button"
            onClick={() => setSelectedWindowId(w.windowId)}
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors',
              tabsOnRight ? 'w-full justify-between' : 'shrink-0',
              isActive
                ? 'border-primary bg-primary/10 font-medium text-primary'
                : 'text-muted-foreground hover:bg-muted/50',
            )}
          >
            <span>{w.windowId === '' ? 'Legacy' : `Tab ${i + 1}`}</span>
            <span className="font-mono opacity-70">
              {formatDuration(w.durationMs)}
            </span>
          </button>
        );
      })
    : null;

  // Remount ReplayContent on window switch (key) so the rrweb player, chunk
  // buffer, and all internal state reset cleanly to the selected recording.
  const player = (
    <ReplayContent
      key={activeWindowId ?? 'default'}
      projectId={projectId}
      sessionId={sessionId}
      windowId={activeWindowId ?? undefined}
      windowDurationMs={activeWindow?.durationMs}
      showEventFeed={showEventFeed}
      controlsRef={controlsRef}
    />
  );

  // Session Replays tab: player fills the space, tabs are a vertical rail on
  // the right (uses the otherwise-empty horizontal space).
  if (tabsOnRight) {
    return (
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">{player}</div>
        {multiWindow && (
          <div className="flex max-h-[82vh] w-32 shrink-0 flex-col gap-1.5 overflow-y-auto">
            <span className="px-0.5 text-xs font-medium text-muted-foreground">
              {windows!.length} tabs
            </span>
            {windowButtons}
          </div>
        )}
      </div>
    );
  }

  // Session detail page: switcher as a horizontal scroll row above the player.
  return (
    <div className="flex flex-col gap-3">
      {multiWindow && (
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">
            {windows!.length} tabs
          </span>
          <div className="flex flex-nowrap gap-1.5 overflow-x-auto pb-1">
            {windowButtons}
          </div>
        </div>
      )}
      {player}
    </div>
  );
}
