import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ReplayStaleListError } from './replay-block-client';
import type { FetchReplayBlocks } from './replay-block-client';
import { type ReplayEvent, mergeChunkEvents } from './replay-block-decode';
import { planNextBatch, playbackStatus } from './replay-block-planner';
import { type ReplayBlockMeta, ReplayBlockStore } from './replay-block-store';

export interface ReplayPlayerInstance {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  goto: (timeOffset: number, play?: boolean) => void;
  setSpeed: (speed: number) => void;
  getMetaData: () => { startTime: number; endTime: number; totalTime: number };
  getReplayer: () => { getCurrentTime: () => number };
  addEvent: (event: { type: number; data: unknown; timestamp: number }) => void;
  addEventListener: (
    event: string,
    handler: (e: { payload: unknown }) => void,
  ) => void;
  $set?: (props: Record<string, unknown>) => void;
  $destroy?: () => void;
}

type CurrentTimeListener = (t: number) => void;

interface ReplayContextValue {
  // High-frequency value: read via ref, not state. Use subscribeToCurrentTime
  // or useCurrentTime() to get updates without causing 60fps re-renders.
  currentTimeRef: React.MutableRefObject<number>;
  subscribeToCurrentTime: (fn: CurrentTimeListener) => () => void;
  // Low-frequency state (safe to consume directly). True while playing AND
  // while playback is only waiting on data (stalled / seek-then-play), so the
  // play/pause control doesn't flip to "Play" during "Buffering...".
  isPlaying: boolean;
  // Raw wall-clock duration (rrweb coordinate). seek()/currentTime are in this
  // space. The scrubber/readout use the *display* space below instead.
  duration: number;
  startTime: number | null;
  isReady: boolean;
  // Display (gap-collapsed) time space: a window_id is reused across reloads,
  // so its wall-clock span is mostly idle air. The player stays wall-clock;
  // these collapse the idle gaps for the scrubber + time readout only
  // (PostHog-style). Identity fallback (== wall-clock) when no segments are set.
  displayDuration: number;
  // wall-clock offset (ms from startTime) -> gap-collapsed display ms
  toDisplayMs: (wallOffsetMs: number) => number;
  // gap-collapsed display ms -> wall-clock offset (ms from startTime), for seek
  fromDisplayMs: (displayMs: number) => number;
  // Display-space positions of collapsed idle gaps (for scrubber markers).
  segmentBoundariesMs: number[];
  // Register the active recording segments (absolute wall ms) for the playing
  // window. Null/empty -> identity mapping.
  setSegments: (segments: { startMs: number; endMs: number }[] | null) => void;
  // Buffered regions (wall-clock offsets from startTime) for the buffered bar.
  // Loading is progressive, so there can be holes (after a far seek).
  loadedUpToMs: number;
  loadedRanges: { startMs: number; endMs: number }[];
  // True while a seek is loading or playback is stalled waiting for data.
  isBuffering: boolean;
  // Events the rrweb player is constructed with (the loaded prefix of the
  // recording up to its first FullSnapshot), null until they are loaded.
  initialEvents: ReplayEvent[] | null;
  // Set when the recording could not be loaded at all.
  loadError: string | null;
  // Set when loading MORE of an already-playing recording keeps failing
  // (shown instead of an endless "Buffering..."); retryLoad retries now.
  bufferError: string | null;
  retryLoad: () => void;
  // Blocks of this window and how many are in the player (diagnostics).
  blockProgress: { total: number; applied: number };
  // Playback controls
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (timeMs: number) => void;
  speed: number;
  setSpeed: (speed: number) => void;
  refreshDuration: () => void;
  // Called by ReplayPlayer to register/unregister the rrweb instance
  onPlayerReady: (
    player: ReplayPlayerInstance,
    playerStartTime: number,
  ) => void;
  onPlayerDestroy: () => void;
  /** rrweb's 'finish': the playhead ran past the last event IN THE PLAYER. */
  onPlayerFinish: () => void;
  setCurrentTime: (t: number) => void;
  setIsPlaying: (p: boolean) => void;
  setDuration: (d: number) => void;
}

const ReplayContext = createContext<ReplayContextValue | null>(null);

const SPEED_OPTIONS = [0.5, 1, 2, 4, 8] as const;

/** How often (real time) the loader re-plans while the playhead moves. */
const TICK_INTERVAL_MS = 250;
/** Failed block requests retry with exponential backoff, capped. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 15_000;
/** Load failures (initial, or later while playing) before showing an error. */
const INITIAL_FAILURES_BEFORE_ERROR = 3;
/** Resuming from a stall with skip-inactivity on jumps idle air longer than
 * this (rrweb's own inactivity threshold) instead of waiting through it: the
 * fast-forward rrweb would have done can't trigger across a load boundary. */
const STALL_SKIP_GAP_MS = 10_000;

/**
 * Insert sorted events into the rrweb replayer's own event list WITHOUT
 * casting them (its addEvent() casts anything older than the baseline onto
 * the current DOM), and forget rrweb's last played event. rrweb's play()
 * skips every event at or before the last played one when moving forward,
 * so without the reset a following goto(current) would never draw the
 * inserted events behind the playhead. With it, that one goto rebuilds from
 * the nearest FullSnapshot and replays everything in order. Returns false if
 * the internal state isn't reachable, so callers can fall back to addEvent().
 */
function insertEventsWithoutCasting(
  player: ReplayPlayerInstance,
  events: ReplayEvent[],
): boolean {
  const replayer = player.getReplayer() as unknown as {
    service?: {
      state?: {
        context?: {
          events?: { timestamp: number }[];
          lastPlayedEvent?: unknown;
        };
      };
    };
  };
  const context = replayer?.service?.state?.context;
  const list = context?.events;
  if (!context || !Array.isArray(list) || !('lastPlayedEvent' in context)) {
    return false;
  }
  context.lastPlayedEvent = null;
  for (const ev of events) {
    // Binary search: insert after any event with the same timestamp.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid]?.timestamp ?? 0) <= ev.timestamp) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, ev);
  }
  return true;
}

/** Let rrweb ingest queued addEvent()s (it applies them on a microtask). */
const nextMacrotask = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export function useReplayContext() {
  const ctx = useContext(ReplayContext);
  if (!ctx) {
    throw new Error('useReplayContext must be used within ReplayProvider');
  }
  return ctx;
}

/**
 * Subscribe to currentTime updates at a throttled rate.
 * intervalMs=0 means every tick (use for the progress bar DOM writes).
 * intervalMs=250 means 4 updates/second (use for text displays).
 */
export function useCurrentTime(intervalMs = 0): number {
  const { currentTimeRef, subscribeToCurrentTime } = useReplayContext();
  const [time, setTime] = useState(currentTimeRef.current);
  const lastUpdateRef = useRef(0);

  useEffect(() => {
    return subscribeToCurrentTime((t) => {
      if (intervalMs === 0) {
        setTime(t);
        return;
      }
      const now = performance.now();
      if (now - lastUpdateRef.current >= intervalMs) {
        lastUpdateRef.current = now;
        setTime(t);
      }
    });
  }, [subscribeToCurrentTime, intervalMs]);

  return time;
}

type PendingSeek = {
  gen: number;
  targetWallMs: number;
  offsetMs: number;
  wantsPlay: boolean;
};

type InFlight = {
  controller: AbortController;
  positions: number[];
  seek: boolean;
};

/**
 * Player state + the PostHog-style block loader for ONE window (tab).
 *
 * Loading: the window's blocks (from session.replayBlocks) live in a
 * ReplayBlockStore; a single loop (tick) asks the planner for the next batch
 * (initial / buffer ahead / seek), fetches it (one request in flight, the
 * decode happens in a Web Worker), and hands new events to rrweb without ever
 * letting it cast an event onto the wrong DOM. Exactly one loader per window:
 * the store only requests 'unloaded' blocks, and the provider is keyed per
 * window, so a remount or a window switch aborts the in-flight request.
 */
export function ReplayProvider({
  children,
  totalDurationMs,
  blocks,
  fetchBlocks,
  onStale,
  skipInactive = true,
}: {
  children: ReactNode;
  /**
   * Definitive replay duration (from the block list). When provided, it owns
   * the duration so the timeline doesn't grow as blocks load.
   */
  totalDurationMs?: number;
  /** This window's blocks (sorted by start). Undefined = nothing to load yet. */
  blocks?: ReplayBlockMeta[];
  fetchBlocks?: FetchReplayBlocks;
  /** The server refused a request as stale (409): refetch the block list. */
  onStale?: () => void;
  /** Used when resuming from a stall (jump idle air across a load boundary). */
  skipInactive?: boolean;
}) {
  const playerRef = useRef<ReplayPlayerInstance | null>(null);
  const isPlayingRef = useRef(false);
  const currentTimeRef = useRef(0);
  const listenersRef = useRef<Set<CurrentTimeListener>>(new Set());
  const startTimeRef = useRef<number | null>(null);
  // rrweb casts an added event SYNCHRONOUSLY (onto whatever DOM is showing)
  // when its timestamp is before the replayer's baseline: the time of the
  // last play()/goto(). Track it (absolute wall ms) so new events never land
  // that way. -Infinity until the first play/goto (rrweb starts at 0).
  const baselineWallRef = useRef(Number.NEGATIVE_INFINITY);
  // Bumped by every seek (and on teardown): lets async work detect that the
  // playhead moved under it.
  const seekGenRef = useRef(0);
  const pendingSeekRef = useRef<PendingSeek | null>(null);
  // Playback paused because the playhead reached a block not in the player
  // yet ("Buffering..."); the loader resumes it.
  const stalledRef = useRef(false);
  // rrweb finished at the true end of the recording: next play restarts.
  const finishedRef = useRef(false);
  const totalDurationMsRef = useRef<number | undefined>(totalDurationMs);
  const speedRef = useRef(1);
  const skipInactiveRef = useRef(skipInactive);
  skipInactiveRef.current = skipInactive;

  // --- block loading state ---
  const storeRef = useRef(new ReplayBlockStore());
  const seenChunksRef = useRef(new Set<string>());
  // Chunk ids + positions of the initial events (survive a player re-create).
  const initialRef = useRef<{ keys: string[]; seen: Set<string> } | null>(
    null,
  );
  const loopRef = useRef({
    alive: true,
    inFlight: null as InFlight | null,
    failures: 0,
    retryAt: 0,
    retryTimer: null as ReturnType<typeof setTimeout> | null,
    applying: false,
    applyAgain: false,
  });
  const fetchRef = useRef(fetchBlocks);
  fetchRef.current = fetchBlocks;
  const onStaleRef = useRef(onStale);
  onStaleRef.current = onStale;
  const tickRef = useRef<() => void>(() => {});

  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [loadedUpToMs, setLoadedUpToMs] = useState(0);
  const [loadedRanges, setLoadedRanges] = useState<
    { startMs: number; endMs: number }[]
  >([]);
  const [isBuffering, setIsBuffering] = useState(false);
  const [resumePending, setResumePending] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const [initialEvents, setInitialEvents] = useState<ReplayEvent[] | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bufferError, setBufferError] = useState<string | null>(null);
  const [blockProgress, setBlockProgress] = useState({ total: 0, applied: 0 });
  const [segments, setSegmentsState] = useState<
    { startMs: number; endMs: number }[] | null
  >(null);

  const setSegments = useCallback(
    (s: { startMs: number; endMs: number }[] | null) => {
      setSegmentsState(s && s.length > 0 ? s : null);
    },
    [],
  );

  // Piecewise-linear map between wall-clock offsets (rrweb/seek space) and the
  // gap-collapsed display space. Identity when no segments.
  const timeMapping = useMemo(() => {
    if (!segments || startTime == null) {
      return {
        displayDuration: duration,
        toDisplayMs: (wallOffsetMs: number) => wallOffsetMs,
        fromDisplayMs: (displayMs: number) => displayMs,
        segmentBoundariesMs: [] as number[],
      };
    }
    const rows: {
      wallStart: number;
      wallEnd: number;
      compStart: number;
      dur: number;
    }[] = [];
    let acc = 0;
    const norm = segments
      .map((s) => ({
        start: Math.max(0, s.startMs - startTime),
        end: Math.max(0, s.endMs - startTime),
      }))
      .filter((s) => s.end > s.start)
      .sort((a, b) => a.start - b.start);
    for (const s of norm) {
      const dur = s.end - s.start;
      rows.push({ wallStart: s.start, wallEnd: s.end, compStart: acc, dur });
      acc += dur;
    }
    const displayDuration = acc > 0 ? acc : duration;

    const toDisplayMs = (wallOffsetMs: number) => {
      if (rows.length === 0) return wallOffsetMs;
      for (const r of rows) {
        if (wallOffsetMs < r.wallStart) return r.compStart;
        if (wallOffsetMs <= r.wallEnd) {
          return r.compStart + (wallOffsetMs - r.wallStart);
        }
      }
      return displayDuration;
    };

    const fromDisplayMs = (displayMs: number) => {
      if (rows.length === 0) return displayMs;
      const clamped = Math.max(0, Math.min(displayDuration, displayMs));
      for (const r of rows) {
        if (clamped <= r.compStart + r.dur) {
          return r.wallStart + Math.max(0, clamped - r.compStart);
        }
      }
      return rows[rows.length - 1]!.wallEnd;
    };

    const segmentBoundariesMs = rows.slice(1).map((r) => r.compStart);
    return { displayDuration, toDisplayMs, fromDisplayMs, segmentBoundariesMs };
  }, [segments, startTime, duration]);

  const setIsPlayingWithRef = useCallback((playing: boolean) => {
    isPlayingRef.current = playing;
    setIsPlaying(playing);
  }, []);

  const subscribeToCurrentTime = useCallback((fn: CurrentTimeListener) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const setCurrentTime = useCallback((t: number) => {
    currentTimeRef.current = t;
    for (const fn of listenersRef.current) {
      fn(t);
    }
  }, []);

  const updateBuffering = useCallback(() => {
    const seeking = pendingSeekRef.current !== null;
    setIsBuffering(seeking || stalledRef.current);
    setResumePending(
      stalledRef.current ||
        (seeking && (pendingSeekRef.current?.wantsPlay ?? false)),
    );
  }, []);

  const refreshDuration = useCallback(() => {
    const total = playerRef.current?.getMetaData().totalTime ?? 0;
    const td = totalDurationMsRef.current;
    // The list's duration owns the timeline; rrweb's (once the tail loads)
    // may only extend it by the last chunk's own few seconds.
    if (td && td > 0) {
      setDuration((d) => Math.max(td, d, total));
      return;
    }
    if (total > 0) setDuration(total);
  }, []);

  useEffect(() => {
    totalDurationMsRef.current = totalDurationMs;
    if (totalDurationMs && totalDurationMs > 0) {
      setDuration(totalDurationMs);
    }
  }, [totalDurationMs]);

  /** Mirror the store into React state (buffered bar, progress). */
  const publishBuffer = useCallback(() => {
    const store = storeRef.current;
    let applied = 0;
    for (let i = 0; i < store.count; i++) {
      if (store.entry(i)?.state === 'applied') applied++;
    }
    setBlockProgress((p) =>
      p.total === store.count && p.applied === applied
        ? p
        : { total: store.count, applied },
    );
    const base = startTimeRef.current;
    if (base == null) return;
    const ranges = store.loadedRanges().map((r) => ({
      startMs: Math.max(0, r.startMs - base),
      endMs: Math.max(0, r.endMs - base),
    }));
    setLoadedRanges(ranges);
    setLoadedUpToMs(ranges.reduce((m, r) => Math.max(m, r.endMs), 0));
    refreshDuration();
  }, [refreshDuration]);

  /**
   * Every play/goto goes through here so the replayer's baseline is known.
   * Uses rrweb-player's goto(t, play) rather than its play(): after rrweb's
   * 'finish' (which also fires when the playhead merely reaches the end of the
   * events in the player) rrweb-player's play() restarts from 0:00.
   */
  const gotoOffset = useCallback((offsetMs: number, playAfter: boolean) => {
    const player = playerRef.current;
    const base = startTimeRef.current;
    if (!player || base == null) return;
    const t = Math.max(0, offsetMs);
    baselineWallRef.current = base + t;
    finishedRef.current = false;
    player.goto(t, playAfter);
  }, []);

  /**
   * Events older than rrweb's first event move its time base (offsets are
   * relative to events[0]), but our offsets are relative to startTimeRef.
   * Re-read the start and shift our offsets so the playhead keeps its wall
   * position. Returns the shift (ms added to offsets), 0 if unchanged.
   */
  const rebaseIfStartMoved = useCallback(
    (player: ReplayPlayerInstance): number => {
      const base = startTimeRef.current;
      const start = player.getMetaData().startTime;
      if (base == null || !Number.isFinite(start) || start >= base) return 0;
      const shift = base - start;
      startTimeRef.current = start;
      currentTimeRef.current += shift;
      if (pendingSeekRef.current) pendingSeekRef.current.offsetMs += shift;
      setStartTime(start);
      return shift;
    },
    [],
  );

  /**
   * Add events (sorted) to rrweb without letting it cast any of them onto the
   * DOM currently shown. Events behind the playhead/baseline (a seek backfill,
   * a late duplicate block) would be applied synchronously out of context, so
   * the player is first re-based just before the oldest one (paused), the
   * events inserted, then the position restored (unless a seek is about to
   * goto anyway).
   */
  const addEventsSafely = useCallback(
    async (events: ReplayEvent[]) => {
      const player = playerRef.current;
      const base = startTimeRef.current;
      if (!player || base == null || events.length === 0) return;
      const minTs = events[0]!.timestamp;
      const playheadWall = base + currentTimeRef.current;
      const unsafe =
        minTs < baselineWallRef.current ||
        (isPlayingRef.current && minTs < playheadWall);
      const gen = seekGenRef.current;
      // Out-of-order events (a seek backfill, a late block): rrweb's
      // addEvent() casts any event older than its baseline onto the page
      // shown NOW, so older mutations hit a newer snapshot's node ids
      // ("Node with id X not found") and the frame breaks. Insert them into
      // the replayer's sorted event list without casting, then rebuild the
      // current position once with goto(): rrweb replays from the nearest
      // FullSnapshot in timestamp order. PostHog likewise never casts
      // backfilled data into a running replayer.
      if (unsafe && insertEventsWithoutCasting(player, events)) {
        rebaseIfStartMoved(player);
        if (pendingSeekRef.current === null) {
          // One rebuild from the nearest FullSnapshot (the insert reset
          // rrweb's last played event). Two back-to-back gotos raced rrweb's
          // snapshot rebuild ("Only one doctype allowed").
          gotoOffset(currentTimeRef.current, isPlayingRef.current);
        }
        return;
      }
      let restore: { offset: number; play: boolean } | null = null;
      if (unsafe) {
        if (pendingSeekRef.current === null) {
          restore = {
            offset: currentTimeRef.current,
            play: isPlayingRef.current,
          };
        }
        gotoOffset(minTs - base - 1, false);
      }
      for (const ev of events) player.addEvent(ev);
      // rrweb applies addEvent() on a microtask: let them land before any
      // goto, or the goto would rebuild without them.
      await nextMacrotask();
      if (playerRef.current === player) {
        const shift = rebaseIfStartMoved(player);
        if (restore) restore.offset += shift;
      }
      if (
        restore &&
        playerRef.current === player &&
        gen === seekGenRef.current &&
        pendingSeekRef.current === null
      ) {
        gotoOffset(restore.offset, restore.play);
      }
    },
    [gotoOffset, rebaseIfStartMoved],
  );

  /** Hand every loaded-but-not-applied block to rrweb (serialized). */
  const applyPending = useCallback(async () => {
    const loop = loopRef.current;
    if (!playerRef.current || startTimeRef.current == null) return;
    if (loop.applying) {
      loop.applyAgain = true;
      return;
    }
    loop.applying = true;
    try {
      do {
        loop.applyAgain = false;
        const store = storeRef.current;
        const pending = store.pendingApply();
        if (pending.length === 0) break;
        const chunks = pending.flatMap((e) => store.takeChunks(e.pos));
        const events = mergeChunkEvents(chunks, seenChunksRef.current);
        await addEventsSafely(events);
      } while (loop.applyAgain && loop.alive);
    } finally {
      loop.applying = false;
    }
    publishBuffer();
    tickRef.current();
  }, [addEventsSafely, publishBuffer]);

  /** Build the player's initial events once the loaded prefix allows it. */
  const tryBuildInitial = useCallback((): boolean => {
    if (initialRef.current) return true;
    const store = storeRef.current;
    const loop = loopRef.current;
    if (store.count === 0) return false;
    const prefix = store.loadedPrefix();
    if (!prefix) return false;
    const nothingMore =
      loop.inFlight === null &&
      planNextBatch(store, {
        target: null,
        playbackPosition: store.firstStartMs ?? undefined,
      }) === null;
    if (!prefix.hasFullSnapshot && !nothingMore) return false;
    // The whole tab is loaded and it holds no FullSnapshot anywhere: rrweb
    // has nothing to draw on (every other event is a diff on top of one).
    // Usually the tab's only snapshot was dropped as oversize at ingest.
    if (
      nothingMore &&
      store.findNearestFullSnapshot(Number.POSITIVE_INFINITY) === null
    ) {
      setLoadError(
        "This tab can't be replayed: its starting page snapshot was not recorded (often a snapshot too large to ingest). Try another tab.",
      );
      return false;
    }
    // Peek without consuming: rrweb needs at least 2 events to start.
    let eventCount = 0;
    for (const p of prefix.positions) {
      for (const c of store.entry(p)!.chunks ?? [])
        eventCount += c.events.length;
    }
    if (eventCount < 2 && !nothingMore) return false;
    if (eventCount < 2) {
      setLoadError('This recording has no playable events.');
      return false;
    }
    const chunks = prefix.positions.flatMap((p) => store.takeChunks(p));
    const events = mergeChunkEvents(chunks, seenChunksRef.current);
    initialRef.current = {
      // By key: positions shift when the list is re-set (live re-list).
      keys: prefix.positions
        .map((p) => store.entry(p)?.meta.key)
        .filter((k): k is string => k !== undefined),
      seen: new Set(seenChunksRef.current),
    };
    setInitialEvents(events);
    publishBuffer();
    return true;
  }, [publishBuffer]);

  const finishSeek = useCallback(
    (ps: PendingSeek) => {
      if (pendingSeekRef.current !== ps) return;
      pendingSeekRef.current = null;
      updateBuffering();
      gotoOffset(ps.offsetMs, ps.wantsPlay);
    },
    [gotoOffset, updateBuffering],
  );

  const stallForBuffering = useCallback(() => {
    if (stalledRef.current || pendingSeekRef.current !== null) return;
    stalledRef.current = true;
    updateBuffering();
    playerRef.current?.pause();
  }, [updateBuffering]);

  const resumeFromStall = useCallback(() => {
    if (!stalledRef.current || pendingSeekRef.current !== null) return;
    const base = startTimeRef.current;
    stalledRef.current = false;
    updateBuffering();
    let t = currentTimeRef.current;
    if (skipInactiveRef.current && base != null) {
      const playhead = base + t;
      const next = storeRef.current.nextBlockStartAfter(playhead);
      if (next !== null && next - playhead > STALL_SKIP_GAP_MS) {
        t = next - base - 1;
      }
    }
    gotoOffset(t, true);
  }, [gotoOffset, updateBuffering]);

  const fetchBatch = useCallback(
    (positions: number[], seek: boolean) => {
      const loop = loopRef.current;
      const fetchFn = fetchRef.current;
      const store = storeRef.current;
      if (!fetchFn || positions.length === 0) return;
      const keys = positions.map((p) => store.entry(p)!.meta.key);
      store.markLoading(positions);
      const controller = new AbortController();
      const inFlight: InFlight = { controller, positions, seek };
      loop.inFlight = inFlight;
      // Completion works by KEY: the list can be re-set while this request is
      // in flight (live re-list every 10 s, a late block sorting earlier), which
      // reassigns positions. Using the positions captured above would mark the
      // wrong entries loaded (with empty data) and leave the fetched ones
      // stuck in 'loading', stalling playback at them.
      fetchFn(keys, controller.signal)
        .then((byKey) => {
          if (!loop.alive || controller.signal.aborted) {
            store.markUnloadedKeys(keys);
            return;
          }
          // A block the server returned nothing for still counts as loaded
          // (empty): re-requesting it forever would stall the loader.
          for (const key of keys) {
            const p = store.posOfKey(key);
            if (p === undefined) continue; // dropped from the list meanwhile
            store.markLoaded(
              p,
              byKey.get(key) ?? {
                chunks: [],
                fullSnapshots: [],
                minTs: null,
                maxTs: null,
              },
            );
          }
          loop.failures = 0;
          setLoadError(null);
          setBufferError(null);
        })
        .catch((error) => {
          store.markUnloadedKeys(keys);
          // Only an abort WE triggered (unmount, tab switch, seek preempting
          // buffer-ahead) is silent. Any other abort, e.g. a disposed fetcher,
          // is a failure with backoff: returning here without retryAt made
          // .finally() -> tick() -> fetchBatch() spin without ever yielding.
          if (!loop.alive || controller.signal.aborted) {
            return;
          }
          if (error instanceof ReplayStaleListError) {
            onStaleRef.current?.();
          }
          loop.failures += 1;
          if (loop.failures >= INITIAL_FAILURES_BEFORE_ERROR) {
            if (!initialRef.current) {
              setLoadError('Could not load this recording. Retrying...');
            } else {
              setBufferError(
                "Couldn't load the next part of this recording. Retrying...",
              );
            }
          }
          const delay = Math.min(
            RETRY_MAX_MS,
            RETRY_BASE_MS * 2 ** (loop.failures - 1),
          );
          loop.retryAt = Date.now() + delay;
          if (loop.retryTimer) clearTimeout(loop.retryTimer);
          loop.retryTimer = setTimeout(() => {
            loop.retryAt = 0;
            tickRef.current();
          }, delay);
        })
        .finally(() => {
          if (loop.inFlight === inFlight) loop.inFlight = null;
          if (!loop.alive) return;
          publishBuffer();
          if (initialRef.current && playerRef.current) {
            void applyPending();
          } else {
            tickRef.current();
          }
        });
    },
    [applyPending, publishBuffer],
  );

  /**
   * The loader + playback loop step. Cheap and idempotent: called on time
   * updates (throttled), load completions, seeks and play-state changes.
   */
  const tick = useCallback(() => {
    const loop = loopRef.current;
    if (!loop.alive) return;
    const store = storeRef.current;
    if (store.count === 0) return;

    if (!initialRef.current) {
      tryBuildInitial();
    }
    const player = playerRef.current;
    const base = startTimeRef.current;
    const ready = player !== null && base !== null;
    const ps = pendingSeekRef.current;

    if (ready) {
      // A pending seek lands once its target is playable, or once nothing
      // more can be loaded for it (best effort, never hang).
      if (ps) {
        if (store.canPlayAt(ps.targetWallMs)) {
          finishSeek(ps);
        } else if (
          loop.inFlight === null &&
          store.pendingApply().length === 0 &&
          planNextBatch(store, {
            target: ps.targetWallMs,
            playbackPosition: ps.targetWallMs,
          }) === null
        ) {
          finishSeek(ps);
        }
      } else {
        const playheadMs = base + currentTimeRef.current;
        const status = playbackStatus(store, {
          playheadMs,
          speed: speedRef.current,
          playing: isPlayingRef.current,
        });
        if (status.starving && !stalledRef.current) {
          stallForBuffering();
        } else if (stalledRef.current && status.canResume) {
          // rrweb can't play past its last event (it emits 'finish' and
          // stops), so idle air before a block that isn't applied yet is no
          // runway: resume once the player holds events ahead of the playhead.
          const lastEvent = player.getMetaData().endTime;
          if (status.endLoaded || lastEvent > playheadMs + 500) {
            resumeFromStall();
          }
        }
      }
    }

    if (loop.inFlight !== null || Date.now() < loop.retryAt) return;
    const seekNow = pendingSeekRef.current;
    const plan = planNextBatch(store, {
      target: ready && seekNow ? seekNow.targetWallMs : null,
      playbackPosition: ready
        ? (seekNow?.targetWallMs ?? base + currentTimeRef.current)
        : (store.firstStartMs ?? undefined),
    });
    if (!plan) return;
    fetchBatch(plan.positions, plan.reason !== 'buffer_ahead');
  }, [
    tryBuildInitial,
    finishSeek,
    stallForBuffering,
    resumeFromStall,
    fetchBatch,
  ]);
  tickRef.current = tick;

  // Blocks (re)listed: merge into the store by key and continue.
  useEffect(() => {
    storeRef.current.setBlocks(blocks ?? []);
    publishBuffer();
    tickRef.current();
  }, [blocks, publishBuffer]);

  // Lifetime of the loader: one per provider (= per window). Unmount aborts
  // the in-flight request so nothing keeps loading for a closed tab.
  useEffect(() => {
    const loop = loopRef.current;
    loop.alive = true;
    tickRef.current();
    return () => {
      loop.alive = false;
      loop.inFlight?.controller.abort();
      loop.inFlight = null;
      if (loop.retryTimer) clearTimeout(loop.retryTimer);
    };
  }, []);

  // Re-plan while the playhead moves.
  useEffect(() => {
    let last = 0;
    return subscribeToCurrentTime(() => {
      const now = performance.now();
      if (now - last < TICK_INTERVAL_MS) return;
      last = now;
      tickRef.current();
    });
  }, [subscribeToCurrentTime]);

  /** Retry a failing load now instead of waiting out the backoff. */
  const retryLoad = useCallback(() => {
    const loop = loopRef.current;
    if (loop.retryTimer) clearTimeout(loop.retryTimer);
    loop.retryTimer = null;
    loop.retryAt = 0;
    setBufferError(null);
    tickRef.current();
  }, []);

  const onPlayerReady = useCallback(
    (player: ReplayPlayerInstance, playerStartTime: number) => {
      playerRef.current = player;
      startTimeRef.current = playerStartTime;
      setStartTime(playerStartTime);
      currentTimeRef.current = 0;
      baselineWallRef.current = Number.NEGATIVE_INFINITY;
      finishedRef.current = false;
      stalledRef.current = false;
      pendingSeekRef.current = null;
      setIsBuffering(false);
      setResumePending(false);
      setIsPlayingWithRef(false);
      setIsReady(true);
      publishBuffer();
      void applyPending();
    },
    [setIsPlayingWithRef, publishBuffer, applyPending],
  );

  const onPlayerDestroy = useCallback(() => {
    playerRef.current = null;
    startTimeRef.current = null;
    // A re-created player starts from the initial events again: everything
    // applied after them must be loaded again (their data was dropped once
    // handed to rrweb).
    const loop = loopRef.current;
    loop.inFlight?.controller.abort();
    loop.inFlight = null;
    const store = storeRef.current;
    const initial = initialRef.current;
    const keep = new Set(initial?.keys ?? []);
    const reset: number[] = [];
    for (let i = 0; i < store.count; i++) {
      const e = store.entry(i);
      if (e && !keep.has(e.meta.key) && e.state === 'applied') reset.push(i);
    }
    for (const p of reset) {
      const e = store.entry(p)!;
      e.state = 'unloaded';
      e.chunks = null;
    }
    store.version++;
    seenChunksRef.current = new Set(initial?.seen ?? []);
    seekGenRef.current += 1;
    pendingSeekRef.current = null;
    stalledRef.current = false;
    finishedRef.current = false;
    baselineWallRef.current = Number.NEGATIVE_INFINITY;
    setIsReady(false);
    currentTimeRef.current = 0;
    const td = totalDurationMsRef.current;
    if (!(td && td > 0)) setDuration(0);
    setStartTime(null);
    setIsPlayingWithRef(false);
    setLoadedUpToMs(0);
    setLoadedRanges([]);
    setIsBuffering(false);
    setResumePending(false);
  }, [setIsPlayingWithRef]);

  const play = useCallback(() => {
    if (isPlayingRef.current || stalledRef.current) return;
    const ps = pendingSeekRef.current;
    if (ps) {
      ps.wantsPlay = true;
      updateBuffering();
      return;
    }
    gotoOffset(finishedRef.current ? 0 : currentTimeRef.current, true);
  }, [gotoOffset, updateBuffering]);

  const pause = useCallback(() => {
    // Pausing also cancels a pending resume (stall) or play-after-seek.
    if (pendingSeekRef.current) pendingSeekRef.current.wantsPlay = false;
    stalledRef.current = false;
    updateBuffering();
    playerRef.current?.pause();
  }, [updateBuffering]);

  const toggle = useCallback(() => {
    const wantsPlay =
      isPlayingRef.current ||
      stalledRef.current ||
      (pendingSeekRef.current?.wantsPlay ?? false);
    if (wantsPlay) pause();
    else play();
  }, [play, pause]);

  const seek = useCallback(
    (timeMs: number) => {
      const base = startTimeRef.current;
      const player = playerRef.current;
      if (base == null || !player) return;
      const t = Math.max(0, timeMs);
      const targetWallMs = base + t;
      const gen = ++seekGenRef.current;
      // Keep playing after the seek if playback was running, stalled, or an
      // earlier (now superseded) seek was going to resume it.
      const wantsPlay =
        isPlayingRef.current ||
        stalledRef.current ||
        (pendingSeekRef.current?.wantsPlay ?? false);
      stalledRef.current = false;

      if (storeRef.current.canPlayAt(targetWallMs)) {
        pendingSeekRef.current = null;
        updateBuffering();
        gotoOffset(t, wantsPlay);
        tickRef.current();
        return;
      }
      // Not playable yet: pause, load around the target (+ backfill to its
      // FullSnapshot), then goto. A buffer-ahead request in flight is dropped:
      // the seek needs the connection more.
      pendingSeekRef.current = { gen, targetWallMs, offsetMs: t, wantsPlay };
      updateBuffering();
      player.pause();
      const inFlight = loopRef.current.inFlight;
      if (inFlight && !inFlight.seek) inFlight.controller.abort();
      tickRef.current();
    },
    [gotoOffset, updateBuffering],
  );

  const onPlayerFinish = useCallback(() => {
    const base = startTimeRef.current;
    if (base == null || pendingSeekRef.current !== null) return;
    const playhead = base + currentTimeRef.current;
    const endLoaded =
      storeRef.current.playableUntil(playhead) === Number.POSITIVE_INFINITY;
    if (!endLoaded) {
      // Ran out of events IN THE PLAYER, not out of recording: a stall. Only
      // if it was actually playing (a paused goto past the data also emits
      // 'finish').
      if (isPlayingRef.current && !stalledRef.current) {
        stalledRef.current = true;
        updateBuffering();
        tickRef.current();
      }
      return;
    }
    finishedRef.current = true;
  }, [updateBuffering]);

  const setSpeed = useCallback((s: number) => {
    if (!SPEED_OPTIONS.includes(s as (typeof SPEED_OPTIONS)[number])) return;
    const base = startTimeRef.current;
    // rrweb-player re-plays from the current time when the speed changes
    // while playing: that moves the replayer's baseline.
    if (isPlayingRef.current && base != null) {
      baselineWallRef.current = base + currentTimeRef.current;
    }
    playerRef.current?.setSpeed(s);
    speedRef.current = s;
    setSpeedState(s);
  }, []);

  // Re-plan on discrete changes the time ticks don't cover. fetchBlocks is
  // included because the fetcher is created in an effect and can arrive after
  // the loader's first tick, which would otherwise never fetch.
  useEffect(() => {
    tickRef.current();
  }, [isPlaying, speed, isReady, fetchBlocks]);

  const value: ReplayContextValue = {
    currentTimeRef,
    subscribeToCurrentTime,
    isPlaying: isPlaying || resumePending,
    duration,
    startTime,
    isReady,
    displayDuration: timeMapping.displayDuration,
    toDisplayMs: timeMapping.toDisplayMs,
    fromDisplayMs: timeMapping.fromDisplayMs,
    segmentBoundariesMs: timeMapping.segmentBoundariesMs,
    setSegments,
    loadedUpToMs,
    loadedRanges,
    isBuffering,
    initialEvents,
    loadError,
    bufferError,
    retryLoad,
    blockProgress,
    play,
    pause,
    toggle,
    seek,
    speed,
    setSpeed,
    refreshDuration,
    onPlayerReady,
    onPlayerDestroy,
    onPlayerFinish,
    setCurrentTime,
    setIsPlaying: setIsPlayingWithRef,
    setDuration,
  };

  return (
    <ReplayContext.Provider value={value}>{children}</ReplayContext.Provider>
  );
}

export { SPEED_OPTIONS };
