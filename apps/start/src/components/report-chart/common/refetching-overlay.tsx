import { cn } from '@/utils/cn';
import { useEffect, useState } from 'react';

interface RefetchingOverlayProps {
  isRefetching: boolean;
}

export function RefetchingOverlay({ isRefetching }: RefetchingOverlayProps) {
  const [showSlowHint, setShowSlowHint] = useState(false);

  useEffect(() => {
    if (!isRefetching) {
      setShowSlowHint(false);
      return;
    }

    const timeout = setTimeout(() => setShowSlowHint(true), 4000);
    return () => clearTimeout(timeout);
  }, [isRefetching]);

  if (!isRefetching) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'absolute inset-0 z-10 flex items-center justify-center',
        'bg-background/50 backdrop-blur-[1px] rounded',
        'animate-in fade-in duration-200',
      )}
    >
      <div className="flex flex-col items-center gap-2 px-4 text-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <ThinkingDots />
          <span className="text-sm font-medium">
            Hang tight — crunching your data…
          </span>
        </div>
        {showSlowHint && (
          <span className="text-xs text-muted-foreground/70 animate-in fade-in duration-300">
            Larger queries can take a few seconds.
          </span>
        )}
      </div>
    </div>
  );
}

function ThinkingDots() {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      <span className="size-1.5 rounded-full bg-current animate-pulse [animation-delay:-0.3s] motion-reduce:animate-none" />
      <span className="size-1.5 rounded-full bg-current animate-pulse [animation-delay:-0.15s] motion-reduce:animate-none" />
      <span className="size-1.5 rounded-full bg-current animate-pulse motion-reduce:animate-none" />
    </span>
  );
}
