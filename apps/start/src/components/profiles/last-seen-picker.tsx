import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/utils/cn';
import { format, isValid, parse } from 'date-fns';
import { ArrowRightIcon, CheckIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

type Mode = 'fixed' | 'since';

interface Props {
  /** DB-format 'yyyy-MM-dd HH:mm:ss' (naive, read in the project timezone). */
  startDate: string | null;
  endDate: string | null;
  onApply: (startDate: string, endDate: string | null) => void;
  className?: string;
  children: ReactNode;
}

const DATE_FMT = 'MMM d, yyyy';
const DATETIME_FMT = 'MMM d, yyyy, hh:mm a';
const DB_FMT = 'yyyy-MM-dd HH:mm:ss';

// Parse a persisted DB-format string with date-fns (not `new Date(...)`, which
// is browser-dependent for space-separated `yyyy-MM-dd HH:mm:ss` — Safari yields
// Invalid Date). Returns undefined for null/invalid so the picker stays empty
// rather than showing NaN.
function parseDb(s: string | null): Date | undefined {
  if (!s) return undefined;
  const d = parse(s, DB_FMT, new Date());
  return isValid(d) ? d : undefined;
}

// Copy a calendar-picked day onto an existing datetime, preserving the time
// (react-day-picker returns midnight). Falls back to a default HH:mm.
function withDay(
  day: Date | undefined,
  prev: Date | undefined,
  fallback: [number, number],
): Date | undefined {
  if (!day) return undefined;
  const d = new Date(day);
  if (prev) d.setHours(prev.getHours(), prev.getMinutes(), 0, 0);
  else d.setHours(fallback[0], fallback[1], 0, 0);
  return d;
}

/**
 * Mixpanel-style date-range picker for the profiles "Last seen" window:
 * mode sidebar (Fixed / Since), editable Starts/Ends datetime fields (with
 * AM/PM), a dual-month calendar, and an "Enable time ranges" toggle. Scoped to
 * profiles.
 */
export function LastSeenPicker({
  startDate,
  endDate,
  onApply,
  className,
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(
    startDate && !endDate ? 'since' : 'fixed',
  );
  const [from, setFrom] = useState<Date | undefined>(parseDb(startDate));
  const [to, setTo] = useState<Date | undefined>(parseDb(endDate));
  const [enableTime, setEnableTime] = useState(false);

  const sync = () => {
    setMode(startDate && !endDate ? 'since' : 'fixed');
    setFrom(parseDb(startDate));
    setTo(parseDb(endDate));
  };

  const canApply = mode === 'fixed' ? !!from && !!to : !!from;

  // Serialize to the naive DB string. Day-granular unless times are enabled;
  // ends snap to :59 so the window is inclusive.
  const toDb = (d: Date, isEnd: boolean) => {
    const x = new Date(d);
    if (!enableTime) x.setHours(isEnd ? 23 : 0, isEnd ? 59 : 0, isEnd ? 59 : 0, 0);
    else x.setSeconds(isEnd ? 59 : 0, 0);
    return format(x, 'yyyy-MM-dd HH:mm:ss');
  };

  const apply = () => {
    if (!from) return;
    if (mode === 'since') {
      onApply(toDb(from, false), null);
    } else {
      if (!to) return;
      onApply(toDb(from, false), toDb(to, true));
    }
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) sync();
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" className={className}>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        <div className="flex">
          {/* Mode sidebar */}
          <div className="flex w-32 flex-col gap-0.5 border-r p-2">
            {(['fixed', 'since'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  'flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors',
                  mode === m
                    ? 'bg-def-200 text-foreground'
                    : 'text-muted-foreground hover:bg-def-100 hover:text-foreground',
                )}
              >
                {m === 'fixed' ? 'Fixed' : 'Since'}
                {mode === m && <CheckIcon className="size-3.5" />}
              </button>
            ))}
          </div>
          {/* Main */}
          <div className="flex flex-col">
            <div className="flex items-end gap-2 border-b p-3">
              <DateTimeField
                label="Starts"
                value={from}
                withTime={enableTime}
                onChange={setFrom}
              />
              <ArrowRightIcon className="mb-2 size-4 shrink-0 text-muted-foreground" />
              {mode === 'since' ? (
                <StaticField label="Ends" text="Now" />
              ) : (
                <DateTimeField
                  label="Ends"
                  value={to}
                  withTime={enableTime}
                  onChange={setTo}
                />
              )}
            </div>
            <div className="p-1">
              {mode === 'fixed' ? (
                <Calendar
                  mode="range"
                  captionLayout="dropdown"
                  numberOfMonths={2}
                  defaultMonth={from ?? new Date()}
                  selected={{ from, to }}
                  toDate={new Date()}
                  onSelect={(range) => {
                    setFrom(withDay(range?.from, from, [0, 0]));
                    setTo(withDay(range?.to, to, [23, 59]));
                  }}
                />
              ) : (
                <Calendar
                  mode="single"
                  captionLayout="dropdown"
                  numberOfMonths={2}
                  defaultMonth={from ?? new Date()}
                  selected={from}
                  toDate={new Date()}
                  onSelect={(day) => setFrom(withDay(day, from, [0, 0]))}
                />
              )}
            </div>
          </div>
        </div>
        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t p-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <Switch checked={enableTime} onCheckedChange={setEnableTime} />
            Enable time ranges
          </label>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={apply} disabled={!canApply} icon={CheckIcon}>
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Editable datetime field. Free-type "Jun 4, 2026, 01:00 PM" (or just the date)
// and it commits on blur/Enter; invalid input reverts to the last good value.
function DateTimeField({
  label,
  value,
  withTime,
  onChange,
}: {
  label: string;
  value: Date | undefined;
  withTime: boolean;
  onChange: (date: Date) => void;
}) {
  const fmt = withTime ? DATETIME_FMT : DATE_FMT;
  const [text, setText] = useState(value ? format(value, fmt) : '');

  useEffect(() => {
    setText(value ? format(value, fmt) : '');
  }, [value, fmt]);

  const commit = () => {
    const raw = text.trim();
    if (!raw) {
      setText(value ? format(value, fmt) : '');
      return;
    }
    // Accept both "hh:mm a" and "h:mm a", and a bare date.
    const candidates = withTime
      ? [DATETIME_FMT, 'MMM d, yyyy, h:mm a', DATE_FMT]
      : [DATE_FMT];
    for (const f of candidates) {
      const parsed = parse(raw, f, value ?? new Date());
      if (isValid(parsed)) {
        onChange(parsed);
        setText(format(parsed, fmt));
        return;
      }
    }
    setText(value ? format(value, fmt) : '');
  };

  return (
    <div className="flex flex-1 flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase text-muted-foreground">
        {label}
      </span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        placeholder={withTime ? 'Mon d, yyyy, hh:mm AM' : 'Mon d, yyyy'}
        className="h-8 min-w-[180px] rounded-md border bg-background px-2.5 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </div>
  );
}

function StaticField({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-1 flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase text-muted-foreground">
        {label}
      </span>
      <div className="h-8 min-w-[180px] rounded-md border bg-muted px-2.5 text-sm leading-8 text-muted-foreground">
        {text}
      </div>
    </div>
  );
}
