import { useProfilesSort } from '@/hooks/use-profiles-sort';
import { LastSeenPicker } from '@/components/profiles/last-seen-picker';
import { cn } from '@/utils/cn';
import { format, parse } from 'date-fns';
import { CalendarClockIcon, XIcon } from 'lucide-react';

const DB_FORMAT = 'yyyy-MM-dd HH:mm:ss';

// Short label for the trigger, e.g. "13 Jun 00:00".
function label(db: string): string {
  try {
    return format(parse(db, DB_FORMAT, new Date()), 'd MMM HH:mm');
  } catch {
    return db;
  }
}

/**
 * "Last seen" (created_at) window for the profiles list. Reuses the app's
 * calendar date-range popover with hour precision (withTime) for a consistent
 * UX. Null by default (no bound); a Clear button removes it.
 */
export function LastSeenRange() {
  const { seenStart, seenEnd, setSeenRange } = useProfilesSort();
  const active = !!(seenStart && seenEnd);

  return (
    <div className="flex items-center gap-1">
      <LastSeenPicker
        startDate={seenStart}
        endDate={seenEnd}
        onApply={(start, end) =>
          // "Since" mode returns a null end — roll it to now so the window is
          // bounded (the backend needs both start and end).
          setSeenRange(start, end ?? format(new Date(), DB_FORMAT))
        }
        className={cn(
          'inline-flex h-8 items-center gap-2 rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-accent',
        )}
      >
        <CalendarClockIcon className="size-4 text-muted-foreground" />
        {active ? (
          <span className="tabular-nums">
            {label(seenStart!)} → {label(seenEnd!)}
          </span>
        ) : (
          'Last seen: All time'
        )}
      </LastSeenPicker>
      {active && (
        <button
          type="button"
          title="Clear last-seen window"
          onClick={() => setSeenRange(null, null)}
          className="flex size-8 items-center justify-center rounded-md border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      )}
    </div>
  );
}
