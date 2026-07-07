import { useReplayContext } from '@/components/sessions/replay/replay-context';
import type { ReplayPlayerInstance } from '@/components/sessions/replay/replay-context';
import { useEffect, useMemo, useRef, useState } from 'react';

import 'rrweb-player/dist/style.css';

/** rrweb meta event (type 4) carries the recorded viewport size */
function getRecordedDimensions(
  events: Array<{ type: number; data: unknown }>,
): { width: number; height: number } | null {
  const meta = events.find((e) => e.type === 4);
  if (
    meta &&
    typeof meta.data === 'object' &&
    meta.data !== null &&
    'width' in meta.data &&
    'height' in meta.data
  ) {
    const { width, height } = meta.data as { width: number; height: number };
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
}

function calcDimensions(
  box: HTMLDivElement,
  aspectRatio: number,
): { width: number; height: number; boxHeight: number } {
  const containerWidth = box.offsetWidth;
  const isFullscreen = !!document.fullscreenElement;
  // boxHeight = the dark player box's height: from its top edge down to the
  // bottom of the viewport, minus room for the timeline strip below it. The
  // box fills the pane; the video is letterboxed to fit inside it.
  const rect = box.getBoundingClientRect();
  const boxHeight = isFullscreen
    ? window.innerHeight - 120
    : Math.max(260, window.innerHeight - rect.top - 92);
  const height = Math.min(Math.round(containerWidth / aspectRatio), boxHeight);
  const width = Math.min(containerWidth, Math.round(height * aspectRatio));
  return { width, height, boxHeight };
}

export function ReplayPlayer({
  events,
  skipInactive = true,
}: {
  events: Array<{ type: number; data: unknown; timestamp: number }>;
  // When true, rrweb fast-forwards through periods with no recorded
  // activity — so a mostly-idle recording (e.g. a backgrounded tab) plays
  // through in its few seconds of real activity instead of frozen minutes.
  skipInactive?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The dark player "box" that fills the pane; the video is letterboxed inside.
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxHeight, setBoxHeight] = useState<number | undefined>(undefined);
  const playerRef = useRef<ReplayPlayerInstance | null>(null);
  const {
    onPlayerReady,
    onPlayerDestroy,
    setCurrentTime,
    setIsPlaying,
    refreshDuration,
  } = useReplayContext();
  const [importError, setImportError] = useState(false);

  const recordedDimensions = useMemo(
    () => getRecordedDimensions(events),
    [events],
  );

  useEffect(() => {
    if (!events.length || !containerRef.current) return;

    // Clear any previous player DOM
    containerRef.current.innerHTML = '';

    let mounted = true;
    let player: ReplayPlayerInstance | null = null;
    let handleVisibilityChange: (() => void) | null = null;

    const aspectRatio = recordedDimensions
      ? recordedDimensions.width / recordedDimensions.height
      : 16 / 9;

    const initial = calcDimensions(
      boxRef.current ?? containerRef.current,
      aspectRatio,
    );
    const { width, height } = initial;
    setBoxHeight(initial.boxHeight);

    import('rrweb-player')
      .then((module) => {
        if (!containerRef.current || !mounted) return;

        const PlayerConstructor = module.default;
        player = new PlayerConstructor({
          target: containerRef.current,
          props: {
            events,
            width,
            height,
            autoPlay: false,
            showController: false,
            speedOption: [0.5, 1, 2, 4, 8],
            UNSAFE_replayCanvas: true,
            skipInactive,
          },
        }) as ReplayPlayerInstance;

        playerRef.current = player;

        // Track play state from replayer (getMetaData() does not expose isPlaying)
        let playingState = false;

        // Wire rrweb's built-in event emitter — no RAF loop needed.
        // Note: rrweb-player does NOT emit ui-update-duration; duration is
        // read from getMetaData() on init and after each addEvent batch.
        player.addEventListener('ui-update-current-time', (e) => {
          const t = e.payload as number;
          setCurrentTime(t);
        });

        player.addEventListener('ui-update-player-state', (e) => {
          const playing = e.payload === 'playing';
          playingState = playing;
          setIsPlaying(playing);
        });

        // Pause on tab hide; resume on show (prevents timer drift).
        // getMetaData() does not expose isPlaying, so we use playingState
        // kept in sync by ui-update-player-state above.
        let wasPlaying = false;
        handleVisibilityChange = () => {
          if (!player) return;
          if (document.hidden) {
            wasPlaying = playingState;
            if (wasPlaying) player.pause();
          } else {
            if (wasPlaying) {
              player.play();
              wasPlaying = false;
            }
          }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Notify context — marks isReady = true. refreshDuration is gated by
        // totalDurationMsRef so it falls back to rrweb's progressive totalTime
        // only when no server-side definitive duration was supplied. Its
        // identity is stable (empty deps), so listing it in this useEffect's
        // deps doesn't cause the player to destroy + recreate.
        const meta = player.getMetaData();
        onPlayerReady(player, meta.startTime);
        refreshDuration();
        // Re-measure after the layout has settled — the initial size is
        // computed at construction when the surrounding panes may not have
        // their final dimensions yet, which otherwise leaves the player small.
        requestAnimationFrame(() => {
          if (mounted) onWindowResize();
        });
        setTimeout(() => {
          if (mounted) onWindowResize();
        }, 150);
      })
      .catch(() => {
        if (mounted) setImportError(true);
      });

    let lastW = 0;
    let lastH = 0;
    const onWindowResize = () => {
      const box = boxRef.current;
      if (!box || !mounted || !playerRef.current?.$set) return;
      const { width: w, height: h, boxHeight: bh } = calcDimensions(
        box,
        aspectRatio,
      );
      setBoxHeight(bh);
      // Only re-apply the video size when it actually changed — avoids churn.
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      playerRef.current.$set({ width: w, height: h });
    };
    window.addEventListener('resize', onWindowResize);
    // Re-measure whenever the box settles/changes size, instead of relying on
    // one-shot timers (which fired inconsistently before the panes had their
    // final dimensions — "sometimes big, sometimes small"). We observe the box,
    // whose WIDTH is layout-driven; the video it contains changes independently.
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => onWindowResize())
        : null;
    if (resizeObserver && boxRef.current) {
      resizeObserver.observe(boxRef.current);
    }
    // Recompute dimensions when the user enters/exits fullscreen — the window
    // doesn't fire a `resize` event for the fullscreen transition. Wait a
    // frame so the browser has time to flush the fullscreen layout before we
    // read containerRef.offsetWidth.
    const fullscreenResizeTimers: ReturnType<typeof setTimeout>[] = [];
    const onFullscreenChange = () => {
      // Entering/exiting fullscreen reflows over several frames — a single
      // recompute reads a stale width and leaves the player mis-sized on the
      // way back to normal. Recompute now and again after the layout settles.
      requestAnimationFrame(onWindowResize);
      fullscreenResizeTimers.push(
        setTimeout(onWindowResize, 120),
        setTimeout(onWindowResize, 350),
      );
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);

    return () => {
      mounted = false;
      for (const t of fullscreenResizeTimers) clearTimeout(t);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onWindowResize);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      if (handleVisibilityChange) {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (player) {
        player.pause();
      }
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
      playerRef.current = null;
      onPlayerDestroy();
    };
  }, [events, recordedDimensions, onPlayerReady, onPlayerDestroy, setCurrentTime, setIsPlaying, refreshDuration]);

  // Toggle skip-inactive live without recreating the player. rrweb-player is
  // a Svelte component — $set updates the reactive prop, which internally
  // calls the Replayer's setConfig({ skipInactive }).
  useEffect(() => {
    playerRef.current?.$set?.({ skipInactive });
  }, [skipInactive]);

  if (importError) {
    return (
      <div className="flex h-[320px] items-center justify-center bg-black text-sm text-muted-foreground">
        Failed to load replay player.
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      className="relative flex w-full items-center justify-center overflow-hidden bg-neutral-950 [&_.rr-player]:!rounded-none [&_.rr-player]:!bg-transparent [&_.rr-player]:!shadow-none [&_.rr-player__frame]:!rounded-none"
      style={boxHeight ? { height: `${boxHeight}px` } : undefined}
    >
      <div ref={containerRef} className="flex items-center justify-center" />
    </div>
  );
}
