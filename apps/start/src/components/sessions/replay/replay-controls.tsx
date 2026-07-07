import {
  SPEED_OPTIONS,
  useCurrentTime,
  useReplayContext,
} from '@/components/sessions/replay/replay-context';
import { Button } from '@/components/ui/button';
import { Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { formatDuration } from './replay-utils';

// Cycle order for the speed button (0.5× lives in SPEED_OPTIONS but isn't in
// the click cycle — click ramps up, common-speeds only).
const SPEED_CYCLE = SPEED_OPTIONS.filter((s) => s >= 1);

export function ReplaySpeedControl() {
  const { setSpeed, isReady } = useReplayContext();
  const [speed, setSpeedState] = useState(1);

  if (!isReady) return null;

  const cycle = () => {
    const idx = SPEED_CYCLE.indexOf(speed as (typeof SPEED_CYCLE)[number]);
    const next = SPEED_CYCLE[(idx + 1) % SPEED_CYCLE.length]!;
    setSpeedState(next);
    setSpeed(next);
  };

  return (
    <button
      type="button"
      onClick={cycle}
      title="Playback speed"
      className="rounded-md border px-2 py-1 text-xs font-medium tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {speed}×
    </button>
  );
}

export function ReplayTime() {
  const { duration } = useReplayContext();
  const currentTime = useCurrentTime(250);

  return (
    <span className="text-sm tabular-nums text-muted-foreground font-mono">
      {formatDuration(currentTime)} / {formatDuration(duration)}
    </span>
  );
}

export function ReplayPlayPauseButton() {
  const { isPlaying, isReady, toggle } = useReplayContext();

  if (!isReady) return null;

  return (
    <Button
      type="button"
      variant={isPlaying ? 'outline' : 'default'}
      size="icon"
      onClick={toggle}
      aria-label={isPlaying ? 'Pause' : 'Play'}
    >
      {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
    </Button>
  );
}
