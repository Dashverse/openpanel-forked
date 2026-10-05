import type { IServiceEvent } from '@openpanel/db';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AppWindowIcon,
  FastForwardIcon,
  GlobeIcon,
  Loader2Icon,
  Maximize2,
  Minimize2,
  MonitorOffIcon,
} from 'lucide-react';
import type { MutableRefObject, ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
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

/**
 * Registers the window's active recording segments with the player context, so
 * the scrubber + time readout collapse idle gaps (display space). Must render
 * inside <ReplayProvider>.
 */
function ReplaySegmentsBootstrap({
  segments,
}: {
  segments?: { startMs: number; endMs: number }[];
}) {
  const { setSegments } = useReplayContext();
  useEffect(() => {
    setSegments(segments ?? null);
    return () => setSegments(null);
  }, [segments, setSegments]);
  return null;
}

/** The tab (window) the studio player is showing — read by share links. */
const ActiveReplayWindowContext = createContext<string | undefined>(undefined);

/**
 * For the Session Replays header's share menu: the playing tab and the current
 * position in DISPLAY time (the idle-collapsed clock the readout shows), so a
 * shared "?t=252" opens at the same "4:12" the sender saw.
 */
export function useReplayShareState() {
  const windowId = useContext(ActiveReplayWindowContext);
  const { isReady, toDisplayMs } = useReplayContext();
  const currentTime = useCurrentTime(500);
  return {
    windowId,
    isReady,
    currentDisplayMs: isReady ? toDisplayMs(currentTime) : 0,
  };
}

/** Display (idle-collapsed) ms → wall-clock offset from the recording start. */
function displayToWallOffset(
  displayMs: number,
  segments: { startMs: number; endMs: number }[],
  startTime: number,
): number {
  let acc = 0;
  const sorted = [...segments]
    .map((s) => ({
      start: Math.max(0, s.startMs - startTime),
      end: Math.max(0, s.endMs - startTime),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  for (const s of sorted) {
    const dur = s.end - s.start;
    if (displayMs <= acc + dur) return s.start + Math.max(0, displayMs - acc);
    acc += dur;
  }
  return sorted.at(-1)?.end ?? displayMs;
}

// Lead-up before a linked absolute moment (`initialAtMs`), so the viewer sees
// what the user was doing right before it (e.g. before a funnel drop-off).
const INITIAL_AT_LEAD_MS = 3000;

/**
 * Seeks once to a shared link's timestamp (display seconds) after the player is
 * ready and the tab's segments are known. Leaves playback paused there.
 * `initialAtMs` (an absolute epoch-ms moment) takes precedence: it seeks to a
 * few seconds before that wall-clock time.
 */
function InitialSeek({
  initialTimeSec,
  initialAtMs,
  segments,
}: {
  initialTimeSec?: number;
  initialAtMs?: number;
  segments?: { startMs: number; endMs: number }[];
}) {
  const { isReady, startTime, seek } = useReplayContext();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    const hasAt = initialAtMs != null && initialAtMs > 0;
    if (!hasAt && (initialTimeSec == null || initialTimeSec <= 0)) return;
    if (!isReady || startTime == null || segments === undefined) return;
    done.current = true;
    if (hasAt) {
      // seek() takes a wall-clock offset from the recording start.
      seek(Math.max(0, initialAtMs! - startTime - INITIAL_AT_LEAD_MS));
      return;
    }
    const displayMs = initialTimeSec! * 1000;
    seek(
      segments.length > 0
        ? displayToWallOffset(displayMs, segments, startTime)
        : displayMs,
    );
  }, [initialTimeSec, initialAtMs, isReady, startTime, segments, seek]);
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
  layout = 'default',
  header,
  userPanel,
  initialTimeSec,
  initialAtMs,
}: {
  // Seek here (display seconds) once loaded — from a shared link.
  initialTimeSec?: number;
  // Or to this absolute moment (epoch ms, minus a short lead-up). Wins over
  // initialTimeSec.
  initialAtMs?: number;
  // 'studio' = Session Replays page (Mixpanel-style: header, dark stage,
  // controls bar, Activity/User side panel). 'default' = session detail page.
  layout?: 'default' | 'studio';
  // Studio only: rendered above the player (session header + tab switcher).
  header?: ReactNode;
  // Studio only: content of the side panel's "User" tab.
  userPanel?: ReactNode;
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
      // Only this tab's events (plus tab-less server events), fetched
      // server-side. A session-wide fetch under a cap returned the NEWEST N of
      // ALL tabs — a busy tab showed 858 of its 4,790 events.
      windowId,
      take: 20000,
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

  // Surface which store this replay is served from (Azure Blob archive vs the
  // ClickHouse hot table). Logged once per session; also shown as a badge below.
  const replaySource = replayMeta?.source;
  useEffect(() => {
    if (replaySource) {
      // eslint-disable-next-line no-console
      console.log(
        `%c[replay] session ${sessionId} served from ${
          replaySource === 'blob' ? 'AZURE BLOB' : 'CLICKHOUSE'
        }`,
        `color:#fff;background:${replaySource === 'blob' ? '#2563eb' : '#6b7280'};padding:2px 6px;border-radius:4px`,
      );
    }
  }, [replaySource, sessionId]);

  // Active recording segments (idle gaps collapsed) for the playing window —
  // drives the gap-collapsed scrubber + time readout (display space).
  const { data: segments } = useQuery(
    trpc.session.replayWindowSegments.queryOptions({
      sessionId,
      projectId,
      windowId,
    }),
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
    const placeholder =
      layout === 'studio'
        ? 'h-full min-h-[320px] bg-neutral-950 text-neutral-400'
        : showEventFeed
          ? 'h-[320px] bg-background'
          : 'h-[calc(100vh-11rem)] bg-neutral-950';
    if (replayLoading && layout === 'studio') {
      return (
        <div
          role="status"
          className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 bg-neutral-950"
        >
          <Loader2Icon className="size-6 animate-spin text-neutral-400" />
          <span className="text-sm text-neutral-300">Loading recording…</span>
        </div>
      );
    }
    if (!hasReplay && layout === 'studio') {
      return (
        <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 bg-neutral-950 text-center">
          <MonitorOffIcon className="size-6 text-neutral-500" />
          <span className="text-sm text-neutral-300">No recording for this tab</span>
          <span className="max-w-xs text-xs text-neutral-500">
            The recording may still be processing, or this tab captured no
            activity. Try another tab above.
          </span>
        </div>
      );
    }
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
    if (hasReplay && layout === 'studio') {
      return (
        <ReplayPlayer events={playerEvents} skipInactive={skipInactive} fill />
      );
    }
    if (hasReplay) {
      return (
        <div className="relative">
          {replaySource ? (
            <div
              className={cn(
                'absolute right-2 top-2 z-10 rounded px-2 py-0.5 text-xs font-medium text-white shadow',
                replaySource === 'blob' ? 'bg-blue-600' : 'bg-neutral-500',
              )}
              title={
                replaySource === 'blob'
                  ? 'Served from Azure Blob archive'
                  : 'Served from ClickHouse hot table'
              }
            >
              {replaySource === 'blob' ? 'Azure Blob' : 'ClickHouse'}
            </div>
          ) : null}
          <ReplayPlayer events={playerEvents} skipInactive={skipInactive} />
        </div>
      );
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

  const loaders = (
    <>
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
    </>
  );

  if (layout === 'studio') {
    return (
      <ReplayProvider
        totalDurationMs={windowDurationMs ?? replayMeta?.totalDurationMs}
      >
        <ActiveReplayWindowContext.Provider value={windowId}>
        <SeekBridge controlsRef={controlsRef} />
        <ReplaySegmentsBootstrap segments={segments} />
        <InitialSeek
          initialTimeSec={initialTimeSec}
          initialAtMs={initialAtMs}
          segments={segments}
        />
        <div
          ref={containerRef}
          id="replay"
          className="grid h-full min-h-0 grid-cols-1 bg-background lg:grid-cols-[minmax(0,1fr)_360px]"
        >
          <div className="flex min-h-0 min-w-0 flex-col">
            {header}
            {/* Current page URL — follows the playhead. */}
            <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/40 px-4 text-xs">
              <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 truncate font-mono">
                {hasReplay ? <BrowserUrlBar events={events} /> : null}
              </div>
              {replaySource && (
                <span
                  className="shrink-0 text-muted-foreground"
                  title={
                    replaySource === 'blob'
                      ? 'Served from the Azure Blob archive'
                      : 'Served from the ClickHouse hot table'
                  }
                >
                  {replaySource === 'blob' ? 'Archive' : 'Live'}
                </span>
              )}
            </div>
            <div className="relative min-h-0 flex-1 bg-neutral-950">
              {renderReplay()}
            </div>
            {(hasReplay || replayLoading) && (
              <ReplayTimeline
                events={events}
                variant="studio"
                trailing={
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-pressed={skipInactive}
                      onClick={() => setSkipInactive((v) => !v)}
                      className={cn(
                        'h-8 gap-1.5 px-2 text-xs',
                        skipInactive
                          ? 'text-primary hover:text-primary'
                          : 'text-muted-foreground',
                      )}
                      title={
                        skipInactive
                          ? 'Skipping inactivity — click to play idle periods too'
                          : 'Playing everything — click to skip idle periods'
                      }
                    >
                      <FastForwardIcon className="size-3.5" />
                      Skip inactivity
                    </Button>
                    <FullscreenButton containerRef={containerRef} />
                  </>
                }
              />
            )}
          </div>
          <aside className="hidden min-h-0 flex-col border-l lg:flex">
            <Tabs defaultValue="activity" className="flex h-full min-h-0 flex-col">
              <TabsList className="shrink-0 px-2">
                <TabsTrigger value="activity" className="py-2">
                  Activity
                  <span className="ml-1.5 tabular-nums text-muted-foreground">
                    {eventsData ? events.length : ''}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="user" className="py-2">
                  User
                </TabsTrigger>
              </TabsList>
              <TabsContent
                value="activity"
                className="mt-0 min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col"
              >
                <ReplayEventFeed
                  events={events}
                  replayLoading={replayLoading}
                  bare
                />
              </TabsContent>
              <TabsContent value="user" className="mt-0 min-h-0 flex-1 overflow-y-auto">
                {userPanel}
              </TabsContent>
            </Tabs>
          </aside>
        </div>
        {loaders}
        </ActiveReplayWindowContext.Provider>
      </ReplayProvider>
    );
  }

  return (
    <ReplayProvider
      totalDurationMs={windowDurationMs ?? replayMeta?.totalDurationMs}
    >
      <SeekBridge controlsRef={controlsRef} />
      <ReplaySegmentsBootstrap segments={segments} />
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
      {loaders}
    </ReplayProvider>
  );
}

type ReplayWindow = {
  windowId: string;
  startedAtMs: number;
  activeDurationMs: number;
};

const SEGMENTED_MAX_TABS = 5;

/**
 * Picks which recorded browser tab (window) to play. Up to 5 tabs render as
 * one segmented control (equal height, aligned, active tab raised); more than
 * that collapse into a dropdown so the header never wraps into a ragged grid.
 */
function WindowSwitcher({
  windows,
  activeWindowId,
  onSelect,
}: {
  windows: ReplayWindow[];
  activeWindowId: string | null;
  onSelect: (windowId: string) => void;
}) {
  if (windows.length <= 1) return null;
  const label = (w: ReplayWindow, i: number) =>
    w.windowId === '' ? 'Legacy' : `Tab ${i + 1}`;
  const startedAt = (w: ReplayWindow) =>
    new Date(w.startedAtMs).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <AppWindowIcon className="size-3.5" />
        {windows.length} tabs
      </span>
      {windows.length > SEGMENTED_MAX_TABS ? (
        <Select value={activeWindowId ?? undefined} onValueChange={onSelect}>
          <SelectTrigger className="h-8 w-auto min-w-44 gap-2 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {windows.map((w, i) => (
              <SelectItem key={w.windowId || 'legacy'} value={w.windowId} className="text-xs">
                <span className="inline-flex w-full items-center gap-3">
                  <span className="font-medium">{label(w, i)}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {formatDuration(w.activeDurationMs)}
                  </span>
                  <span className="text-muted-foreground">{startedAt(w)}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div
          role="tablist"
          aria-label="Recorded tabs"
          className="inline-flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg border bg-muted/50 p-0.5"
        >
          {windows.map((w, i) => {
            const isActive = w.windowId === activeWindowId;
            return (
              <button
                key={w.windowId || 'legacy'}
                type="button"
                role="tab"
                aria-selected={isActive}
                title={`Started ${startedAt(w)}`}
                onClick={() => onSelect(w.windowId)}
                className={cn(
                  'flex h-7 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs transition-colors',
                  isActive
                    ? 'bg-background font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span>{label(w, i)}</span>
                <span className="font-mono tabular-nums opacity-70">
                  {formatDuration(w.activeDurationMs)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ReplayShell({
  sessionId,
  projectId,
  showEventFeed = true,
  controlsRef,
  layout = 'default',
  header,
  userPanel,
  initialWindowId,
  initialTimeSec,
  initialAtMs,
}: {
  // From a shared link: open this tab, at this display time (seconds).
  initialWindowId?: string;
  initialTimeSec?: number;
  // Or at this absolute moment (epoch ms) — wins over initialTimeSec.
  initialAtMs?: number;
  sessionId: string;
  projectId: string;
  showEventFeed?: boolean;
  controlsRef?: MutableRefObject<ReplaySeekControls | null>;
  // 'studio' = the Session Replays page layout (see ReplayContent).
  layout?: 'default' | 'studio';
  // Studio only: session header rendered above the tab switcher.
  header?: ReactNode;
  // Studio only: side panel "User" tab content.
  userPanel?: ReactNode;
}) {
  const trpc = useTRPC();
  const [selectedWindowId, setSelectedWindowId] = useState<string | null>(
    initialWindowId ?? null,
  );
  // A shared link's timestamp applies once. Picking any tab consumes it, so
  // switching away and back doesn't jump to the shared time again (the player
  // remounts per tab, so InitialSeek's own once-guard resets).
  const [linkConsumed, setLinkConsumed] = useState(false);
  const selectWindow = (windowId: string) => {
    setLinkConsumed(true);
    setSelectedWindowId(windowId);
  };

  // List the distinct recorders (tabs) that wrote to this session. Each is a
  // separate rrweb recording — the player must play one at a time to avoid
  // mixing DOM mirror states across concurrent tabs.
  const { data: windows } = useQuery(
    trpc.session.replayWindows.queryOptions({ sessionId, projectId }),
  );

  const hasWindows = (windows?.length ?? 0) > 0;

  // Default to the window with the most recorded (active) time. The earliest
  // one is often a 0–2s stub (redirect / quick reload) — opening it made the
  // player look broken next to the list's duration.
  const defaultWindowId = hasWindows
    ? windows!.reduce((best, w) =>
        w.activeDurationMs > best.activeDurationMs ? w : best,
      ).windowId
    : null;
  // A linked tab that doesn't exist (stale link) falls back to the default.
  const activeWindowId =
    selectedWindowId !== null &&
    (!windows || windows.some((w) => w.windowId === selectedWindowId))
      ? selectedWindowId
      : defaultWindowId;
  const activeWindow = windows?.find((w) => w.windowId === activeWindowId);
  // The shared timestamp applies only to the tab it was taken on (or the
  // default tab when the link has none), and only until the user switches.
  const linkedWindowId = initialWindowId ?? defaultWindowId;
  const linkActive = !linkConsumed && activeWindowId === linkedWindowId;
  const seekTo = linkActive && initialTimeSec != null ? initialTimeSec : undefined;
  const seekToAtMs =
    linkActive && initialAtMs != null ? initialAtMs : undefined;

  const switcher = (
    <WindowSwitcher
      windows={windows ?? []}
      activeWindowId={activeWindowId}
      onSelect={selectWindow}
    />
  );

  // Remount ReplayContent on window switch (key) so the rrweb player, chunk
  // buffer, and all internal state reset cleanly to the selected recording.
  const content = (studioHeader?: ReactNode) => (
    <ReplayContent
      key={activeWindowId ?? 'default'}
      projectId={projectId}
      sessionId={sessionId}
      windowId={activeWindowId ?? undefined}
      windowDurationMs={activeWindow?.durationMs}
      showEventFeed={showEventFeed}
      controlsRef={controlsRef}
      layout={layout}
      header={studioHeader}
      userPanel={userPanel}
      initialTimeSec={seekTo}
      initialAtMs={seekToAtMs}
    />
  );

  if (layout === 'studio') {
    const multi = (windows?.length ?? 0) > 1;
    return content(
      <>
        {header}
        {multi && (
          <div className="flex shrink-0 items-center border-b px-4 py-2">
            {switcher}
          </div>
        )}
      </>,
    );
  }

  // Session detail page: switcher above the player.
  return (
    <div className="flex flex-col gap-3">
      {switcher}
      {content()}
    </div>
  );
}
