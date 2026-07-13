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
}

const DB_FORMAT = 'yyyy-MM-dd HH:mm:ss';

export function CustomDateRangePopover({
  startDate,
  endDate,
  onApply,
  className,
  children,
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

  const canApply = mode === 'fixed' ? !!from && !!to : !!from;

  const apply = () => {
    if (!from) return;
    if (mode === 'since') {
      // Open-ended: the resolver rolls the end to "now" at query time.
      onApply(format(startOfDay(from), DB_FORMAT), null);
    } else {
      if (!to) return;
      onApply(
        format(startOfDay(from), DB_FORMAT),
        format(endOfDay(to), DB_FORMAT),
      );
    }
    setOpen(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setMode(startDate && !endDate ? 'since' : 'fixed');
      setFrom(startDate ? new Date(startDate) : undefined);
      setTo(endDate ? new Date(endDate) : undefined);
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
        <div className="flex items-center justify-between gap-2 border-t p-2">
          <span className="px-1 text-xs text-muted-foreground">
            {mode === 'since'
              ? from
                ? `Since ${format(from, 'MMM d, yyyy')} → now`
                : 'Pick a start date'
              : from && to
                ? `${format(from, 'MMM d')} – ${format(to, 'MMM d, yyyy')}`
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
