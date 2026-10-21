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
import { useAppContext } from '@/hooks/use-app-context';
import { useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';
import type { IServiceEvent, ReplayBlockList } from '@openpanel/db';
import { useQuery } from '@tanstack/react-query';
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
import { createReplayBlockFetcher } from './replay-block-client';
import {
  DEFAULT_IDLE_GAP_MS,
  type ReplayBlockMeta,
  computeBlockSegments,
} from './replay-block-store';
import { ReplayTime } from './replay-controls';
import { ReplayTimeline } from './replay-timeline';
import {
  formatDuration,
  getEventOffsetMs,
  resolveActiveWindowId,
  resolveDefaultWindowId,
} from './replay-utils';

// Which store served this replay (session.replayMeta `source`).
const REPLAY_SOURCE_LABELS: Record<
  'ch' | 'blob' | 'blocks',
  {
    badge: string;
    short: string;
    title: string;
    log: string;
    color: string;
    badgeClass: string;
  }
> = {
  ch: {
    badge: 'ClickHouse',
    short: 'Live',
    title: 'Served from the ClickHouse hot table',
    log: 'CLICKHOUSE',
    color: '#6b7280',
    badgeClass: 'bg-neutral-500',
  },
  blob: {
    badge: 'Azure Blob',
    short: 'Archive',
    title: 'Served from the Azure Blob archive',
    log: 'AZURE BLOB',
    color: '#2563eb',
    badgeClass: 'bg-blue-600',
  },
  blocks: {
    badge: 'Blob blocks',
    short: 'Blocks',
    title: 'Served from Azure Blob replay blocks',
    log: 'BLOB BLOCKS',
    color: '#0d9488',
    badgeClass: 'bg-teal-600',
  },
};

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
/** A recording whose newest block is younger than this is treated as live. */
const LIVE_RECORDING_WINDOW_MS = 2 * 60 * 1000;
/** How often a live recording's block list is re-fetched. */
const LIVE_REFETCH_INTERVAL_MS = 10_000;

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

type SourceLabel =
  (typeof REPLAY_SOURCE_LABELS)[keyof typeof REPLAY_SOURCE_LABELS];

/**
 * The player area (inside the provider): loading / empty / error states, or
 * the rrweb player once the loader has the initial events.
 */
function ReplayStage({
  layout,
  showEventFeed,
  hasReplay,
  listLoading,
  skipInactive,
  sourceLabel,
}: {
  layout: 'default' | 'studio';
  showEventFeed: boolean;
  hasReplay: boolean;
  listLoading: boolean;
  skipInactive: boolean;
  sourceLabel: SourceLabel | null;
}) {
  const { initialEvents, loadError } = useReplayContext();
  const loading =
    listLoading || (hasReplay && initialEvents === null && !loadError);
  // On the Session Replays tab (showEventFeed=false) the loading + empty
  // states use the same dark, tall box as the player, so the UI doesn't jump
  // (small light box -> big dark player) once data arrives. On the session
  // detail page they stay compact.
  const placeholder =
    layout === 'studio'
      ? 'h-full min-h-[320px] bg-neutral-950 text-neutral-400'
      : showEventFeed
        ? 'h-[320px] bg-background'
        : 'h-[calc(100vh-11rem)] bg-neutral-950';

  if (loading && layout === 'studio') {
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
  if (loading) {
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
  if (hasReplay && initialEvents === null && loadError) {
    return (
      <div
        role="alert"
        className={cn(
          'flex flex-col items-center justify-center gap-2 text-center text-sm',
          placeholder,
        )}
      >
        <MonitorOffIcon className="size-6 text-neutral-500" />
        <span>{loadError}</span>
      </div>
    );
  }
  if (!hasReplay || initialEvents === null) {
    if (layout === 'studio') {
      return (
        <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 bg-neutral-950 text-center">
          <MonitorOffIcon className="size-6 text-neutral-500" />
          <span className="text-sm text-neutral-300">
            No recording for this tab
          </span>
          <span className="max-w-xs text-xs text-neutral-500">
            The recording may still be processing, or this tab captured no
            activity. Try another tab above.
          </span>
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
  if (layout === 'studio') {
    return (
      <ReplayPlayer events={initialEvents} skipInactive={skipInactive} fill />
    );
  }
  return (
    <div className="relative">
      {sourceLabel ? (
        <div
          className={cn(
            'absolute right-2 top-2 z-10 rounded px-2 py-0.5 text-xs font-medium text-white shadow',
            sourceLabel.badgeClass,
          )}
          title={sourceLabel.title}
        >
          {sourceLabel.badge}
        </div>
      ) : null}
      <ReplayPlayer events={initialEvents} skipInactive={skipInactive} />
    </div>
  );
}

/** Event feed whose "loading" follows the player's initial load. */
function ReplayFeed({
  events,
  listLoading,
  hasReplay,
  bare,
}: {
  events: IServiceEvent[];
  listLoading: boolean;
  hasReplay: boolean;
  bare?: boolean;
}) {
  const { initialEvents, loadError } = useReplayContext();
  const loading =
    listLoading || (hasReplay && initialEvents === null && !loadError);
  return (
    <ReplayEventFeed events={events} replayLoading={loading} bare={bare} />
  );
}

/**
 * Builds this window's block fetcher (GET /replay/blocks + decode worker).
 * One per player; disposed (worker terminated) on unmount / window switch.
 */
function useReplayBlockFetcher(input: {
  projectId: string;
  sessionId: string;
  windowId?: string;
  source?: string;
}) {
  const { apiUrl } = useAppContext();
  const { projectId, sessionId, windowId, source } = input;
  // Created inside the effect (not useMemo): React may run an effect's
  // cleanup and then mount it again (StrictMode in dev, fast refresh). With
  // useMemo the cleanup disposed a fetcher that was then reused, so every
  // request failed instantly as aborted.
  const [fetcher, setFetcher] = useState<ReturnType<
    typeof createReplayBlockFetcher
  > | null>(null);
  useEffect(() => {
    if (windowId === undefined || !source) {
      setFetcher(null);
      return;
    }
    const f = createReplayBlockFetcher({
      apiUrl,
      projectId,
      sessionId,
      windowId,
      source,
    });
    setFetcher(f);
    return () => {
      f.dispose();
      setFetcher((cur) => (cur === f ? null : cur));
    };
  }, [apiUrl, projectId, sessionId, windowId, source]);
  return fetcher;
}

function ReplayContent({
  sessionId,
  projectId,
  windowId,
  blockList,
  onStaleList,
  showEventFeed = true,
  controlsRef,
  layout = 'default',
  header,
  userPanel,
  initialTimeSec,
  initialAtMs,
}: {
  // Seek here (display seconds) once loaded: from a shared link.
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
  // The recorder (tab) to play. undefined while the block list is loading.
  windowId?: string;
  // session.replayBlocks: source, windows and blocks (undefined = loading).
  blockList?: ReplayBlockList;
  // The server refused a block request as stale: refetch the list.
  onStaleList?: () => void;
  // When false, render the player full-width without the side event feed.
  // Used by the Session Replays tab, which keeps events in its own left list.
  showEventFeed?: boolean;
  // Populated with the player's seek controls so external UIs (the replays
  // event list) can jump the player to an event's timestamp.
  controlsRef?: MutableRefObject<ReplaySeekControls | null>;
}) {
  const trpc = useTRPC();
  const containerRef = useRef<HTMLDivElement>(null);
  const listLoading = blockList === undefined;

  const { data: eventsData } = useQuery({
    ...trpc.event.events.queryOptions({
      projectId,
      sessionId,
      filters: [],
      // Only this tab's events (plus tab-less server events), fetched
      // server-side. A session-wide fetch under a cap returned the NEWEST N of
      // ALL tabs: a busy tab showed 858 of its 4,790 events.
      windowId,
      take: 20000,
      // Request window_id so the feed can scope events to the current tab
      // (with an empty-string fallback for backend / pre-window_id events).
      columnVisibility: { windowId: true },
    }),
    // Wait for the tab to be known, so the events aren't fetched twice.
    enabled: !listLoading,
  });

  // This window's blocks, in time order. Stable identity per list/window.
  const windowBlocks = useMemo<ReplayBlockMeta[] | undefined>(
    () =>
      blockList && windowId !== undefined
        ? blockList.blocks.filter((b) => b.windowId === windowId)
        : undefined,
    [blockList, windowId],
  );
  const windowInfo = blockList?.windows.find((w) => w.windowId === windowId);
  const hasReplay = (windowBlocks?.length ?? 0) > 0;

  // Active recording segments (idle gaps collapsed) from the block spans:
  // the gap-collapsed scrubber + time readout, before any data loads.
  const segments = useMemo(
    () =>
      windowBlocks
        ? computeBlockSegments(
            windowBlocks,
            blockList?.idleGapMs ?? DEFAULT_IDLE_GAP_MS,
          )
        : undefined,
    [windowBlocks, blockList?.idleGapMs],
  );

  // Surface which store this replay is served from. Logged once per session;
  // also shown as a badge.
  const replaySource = blockList?.source;
  const sourceLabel = replaySource ? REPLAY_SOURCE_LABELS[replaySource] : null;
  useEffect(() => {
    if (replaySource) {
      const label = REPLAY_SOURCE_LABELS[replaySource];
      // eslint-disable-next-line no-console
      console.log(
        `%c[replay] session ${sessionId} served from ${label.log}`,
        `color:#fff;background:${label.color};padding:2px 6px;border-radius:4px`,
      );
    }
  }, [replaySource, sessionId]);

  const fetcher = useReplayBlockFetcher({
    projectId,
    sessionId,
    windowId,
    source: replaySource,
  });

  // Scope events to the tab (window) being played. Events with an empty
  // window_id (backend events, and every event in a pre-window_id session)
  // always show.
  const events = (eventsData?.data ?? []).filter(
    (e) => !windowId || !e.windowId || e.windowId === windowId,
  );
  // Skip idle periods by default: a mostly-idle recording plays through in
  // its seconds of real activity instead of frozen minutes. User-toggleable.
  const [skipInactive, setSkipInactive] = useState(true);

  const stage = (
    <ReplayStage
      layout={layout}
      showEventFeed={showEventFeed}
      hasReplay={hasReplay}
      listLoading={listLoading}
      skipInactive={skipInactive}
      sourceLabel={sourceLabel}
    />
  );

  const providerProps = {
    totalDurationMs: windowInfo?.durationMs,
    blocks: windowBlocks,
    fetchBlocks: fetcher?.fetchBlocks,
    onStale: onStaleList,
    skipInactive,
  };

  if (layout === 'studio') {
    return (
      <ReplayProvider {...providerProps}>
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
              {/* Current page URL: follows the playhead. */}
              <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/40 px-4 text-xs">
                <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1 truncate font-mono">
                  {hasReplay ? <BrowserUrlBar events={events} /> : null}
                </div>
                {sourceLabel && (
                  <span
                    className="shrink-0 text-muted-foreground"
                    title={sourceLabel.title}
                  >
                    {sourceLabel.short}
                  </span>
                )}
              </div>
              <div className="relative min-h-0 flex-1 bg-neutral-950">
                {stage}
              </div>
              {(hasReplay || listLoading) && (
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
                            ? 'Skipping inactivity: click to play idle periods too'
                            : 'Playing everything: click to skip idle periods'
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
              <Tabs
                defaultValue="activity"
                className="flex h-full min-h-0 flex-col"
              >
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
                  <ReplayFeed
                    events={events}
                    listLoading={listLoading}
                    hasReplay={hasReplay}
                    bare
                  />
                </TabsContent>
                <TabsContent
                  value="user"
                  className="mt-0 min-h-0 flex-1 overflow-y-auto"
                >
                  {userPanel}
                </TabsContent>
              </Tabs>
            </aside>
          </div>
        </ActiveReplayWindowContext.Provider>
      </ReplayProvider>
    );
  }

  return (
    <ReplayProvider {...providerProps}>
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
                        ? 'Skipping inactivity: click to play idle periods too'
                        : 'Playing everything: click to skip idle periods'
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
            {stage}
            {hasReplay && <ReplayTimeline events={events} />}
          </BrowserChrome>
        </div>
        {showEventFeed && (
          <div className="relative hidden lg:block">
            <div className="absolute inset-0">
              <ReplayFeed
                events={events}
                listLoading={listLoading}
                hasReplay={hasReplay}
              />
            </div>
          </div>
        )}
      </div>
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
              <SelectItem
                key={w.windowId || 'legacy'}
                value={w.windowId}
                className="text-xs"
              >
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
  // Or at this absolute moment (epoch ms): wins over initialTimeSec.
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

  // The block list: source, recorders (tabs) and every block's time span. No
  // payload. Short-lived on both sides (server ~5 s) because live sessions
  // grow; a refused (stale) block request refetches it.
  const { data: blockList, refetch: refetchBlockList } = useQuery({
    ...trpc.session.replayBlocks.queryOptions({ sessionId, projectId }),
    staleTime: 5_000,
    gcTime: 30_000,
    // A recording still in progress keeps growing: re-list its blocks while
    // the newest one is recent (PostHog polls a live recording the same
    // way). The store merges new blocks by key, so playback just extends.
    refetchInterval: (query) => {
      const blocks = query.state.data?.blocks;
      if (!blocks || blocks.length === 0) return false;
      let newest = 0;
      for (const b of blocks) newest = Math.max(newest, b.endMs);
      return Date.now() - newest < LIVE_RECORDING_WINDOW_MS
        ? LIVE_REFETCH_INTERVAL_MS
        : false;
    },
  });
  const onStaleList = useCallback(() => {
    void refetchBlockList();
  }, [refetchBlockList]);

  const windows: ReplayWindow[] = useMemo(
    () =>
      (blockList?.windows ?? []).map((w) => ({
        windowId: w.windowId,
        startedAtMs: w.startMs,
        activeDurationMs: w.activeMs,
      })),
    [blockList],
  );

  // Default to the window with the most recorded (active) time, pinned once
  // resolved: live polling re-lists the windows, and a tab that later
  // overtakes it must not swap (remount) the player mid-watch. Re-picked only
  // if the pinned tab drops out of the list. Stored in state and updated
  // during render (React's "adjust state on prop change" pattern).
  const [pinnedDefaultId, setPinnedDefaultId] = useState<string | null>(null);
  const defaultWindowId = resolveDefaultWindowId(windows, pinnedDefaultId);
  if (defaultWindowId !== null && defaultWindowId !== pinnedDefaultId) {
    setPinnedDefaultId(defaultWindowId);
  }
  // A linked tab that doesn't exist (stale link) falls back to the default.
  const activeWindowId = resolveActiveWindowId({
    selectedId: selectedWindowId,
    defaultId: defaultWindowId,
    windows,
    listLoaded: !!blockList,
  });
  // The shared timestamp applies only to the tab it was taken on (or the
  // default tab when the link has none), and only until the user switches.
  const linkedWindowId = initialWindowId ?? defaultWindowId;
  const linkActive = !linkConsumed && activeWindowId === linkedWindowId;
  const seekTo =
    linkActive && initialTimeSec != null ? initialTimeSec : undefined;
  const seekToAtMs =
    linkActive && initialAtMs != null ? initialAtMs : undefined;

  const switcher = (
    <WindowSwitcher
      windows={windows}
      activeWindowId={activeWindowId}
      onSelect={selectWindow}
    />
  );

  // Remount ReplayContent per window (key) so the rrweb player, block store
  // and loader reset cleanly to the selected recording (and the previous
  // window's in-flight request is aborted). Nothing mounts a loader until the
  // block list is known: no throwaway first mount.
  const content = (studioHeader?: ReactNode) => (
    <ReplayContent
      key={blockList ? `w:${activeWindowId ?? ''}` : 'pending'}
      projectId={projectId}
      sessionId={sessionId}
      windowId={blockList ? (activeWindowId ?? '') : undefined}
      blockList={blockList}
      onStaleList={onStaleList}
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
    const multi = windows.length > 1;
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
