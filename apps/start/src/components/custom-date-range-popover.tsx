import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/utils/cn';
import { endOfDay, format, startOfDay } from 'date-fns';
import { CheckIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';

type Mode = 'fixed' | 'since';

interface CustomDateRangePopoverProps {
  startDate: string | null;
  endDate: string | null;
  onApply: (startDate: string, endDate: string | null) => void;
  className?: string;
  children: ReactNode;
  /**
   * Show HH:mm time inputs alongside the calendar so the range is hour-precise.
   * Off by default → the existing day-granular behaviour (startOfDay/endOfDay).
   */
  withTime?: boolean;
}

const DB_FORMAT = 'yyyy-MM-dd HH:mm:ss';
const DAY = 'yyyy-MM-dd';

export function CustomDateRangePopover({
  startDate,
  endDate,
  onApply,
  className,
  children,
  withTime = false,
}: CustomDateRangePopoverProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(
    startDate && !endDate ? 'since' : 'fixed',
  );
  const [from, setFrom] = useState<Date | undefined>(
    startDate ? new Date(startDate) : undefined,
  );
  const [to, setTo] = useState<Date | undefined>(
    endDate ? new Date(endDate) : undefined,
  );
  const [fromTime, setFromTime] = useState(
    startDate ? format(new Date(startDate), 'HH:mm') : '00:00',
  );
  const [toTime, setToTime] = useState(
    endDate ? format(new Date(endDate), 'HH:mm') : '23:59',
  );

  const canApply = mode === 'fixed' ? !!from && !!to : !!from;

  const apply = () => {
    if (!from) return;
    if (mode === 'since') {
      // Open-ended: the resolver rolls the end to "now" at query time.
      const start = withTime
        ? `${format(from, DAY)} ${fromTime}:00`
        : format(startOfDay(from), DB_FORMAT);
      onApply(start, null);
    } else {
      if (!to) return;
      if (withTime) {
        onApply(`${format(from, DAY)} ${fromTime}:00`, `${format(to, DAY)} ${toTime}:59`);
      } else {
        onApply(
          format(startOfDay(from), DB_FORMAT),
          format(endOfDay(to), DB_FORMAT),
        );
      }
    }
    setOpen(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setMode(startDate && !endDate ? 'since' : 'fixed');
      setFrom(startDate ? new Date(startDate) : undefined);
      setTo(endDate ? new Date(endDate) : undefined);
      setFromTime(startDate ? format(new Date(startDate), 'HH:mm') : '00:00');
      setToTime(endDate ? format(new Date(endDate), 'HH:mm') : '23:59');
    }
    setOpen(next);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" className={className}>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <div className="flex items-center gap-0.5 border-b p-2">
          {(['fixed', 'since'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
                mode === m
                  ? 'bg-def-200 text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {m === 'since' ? 'Since' : 'Fixed'}
            </button>
          ))}
        </div>
        <div>
          {mode === 'fixed' ? (
            <Calendar
              mode="range"
              captionLayout="dropdown"
              numberOfMonths={2}
              defaultMonth={from ?? new Date()}
              selected={{ from, to }}
              toDate={new Date()}
              onSelect={(range) => {
                setFrom(range?.from);
                setTo(range?.to);
              }}
            />
          ) : (
            <Calendar
              mode="single"
              captionLayout="dropdown"
              defaultMonth={from ?? new Date()}
              selected={from}
              toDate={new Date()}
              onSelect={(date) => setFrom(date)}
            />
          )}
        </div>
        {withTime && (
          <div className="flex items-center gap-4 border-t px-3 py-2">
            <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              From
              <input
                type="time"
                value={fromTime}
                onChange={(e) => setFromTime(e.target.value)}
                className="h-7 rounded-md border bg-background px-2 text-sm text-foreground tabular-nums"
              />
            </label>
            {mode === 'fixed' && (
              <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                To
                <input
                  type="time"
                  value={toTime}
                  onChange={(e) => setToTime(e.target.value)}
                  className="h-7 rounded-md border bg-background px-2 text-sm text-foreground tabular-nums"
                />
              </label>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t p-2">
          <span className="px-1 text-xs text-muted-foreground">
            {mode === 'since'
              ? from
                ? `Since ${format(from, 'MMM d, yyyy')}${withTime ? ` ${fromTime}` : ''} → now`
                : 'Pick a start date'
              : from && to
                ? `${format(from, 'MMM d')}${withTime ? ` ${fromTime}` : ''} – ${format(to, 'MMM d, yyyy')}${withTime ? ` ${toTime}` : ''}`
                : 'Pick a range'}
          </span>
          <Button
            size="sm"
            onClick={apply}
            disabled={!canApply}
            icon={CheckIcon}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
