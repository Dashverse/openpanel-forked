import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { pushModal, useOnPushModal } from '@/modals';
import { cn } from '@/utils/cn';
import { bind } from 'bind-event-listener';
import { CalendarIcon } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';

import { shouldIgnoreKeypress } from '@/utils/should-ignore-keypress';
import { timeWindows } from '@openpanel/constants';
import type { IChartRange } from '@openpanel/validation';
import { endOfDay, format, startOfDay } from 'date-fns';

type Props = {
  value: IChartRange;
  onChange: (value: IChartRange) => void;
  onStartDateChange: (date: string) => void;
  onEndDateChange: (date: string) => void;
  endDate: string | null;
  startDate: string | null;
  className?: string;
  segmented?: boolean;
};
const VISIBLE_RANGES: IChartRange[] = [
  'lastHour',
  'today',
  'yesterday',
  '3d',
  '7d',
  '30d',
  '3m',
  'custom',
];

export function TimeWindowPicker({
  value,
  onChange,
  startDate,
  onStartDateChange,
  endDate,
  onEndDateChange,
  className,
  segmented,
}: Props) {
  const isDateRangerPickerOpen = useRef(false);
  useOnPushModal('DateRangerPicker', (open) => {
    isDateRangerPickerOpen.current = open;
  });
  const timeWindow = timeWindows[value ?? '30d'];

  const handleCustom = useCallback(() => {
    pushModal('DateRangerPicker', {
      onChange: ({ startDate, endDate }) => {
        onStartDateChange(format(startOfDay(startDate), 'yyyy-MM-dd HH:mm:ss'));
        onEndDateChange(format(endOfDay(endDate), 'yyyy-MM-dd HH:mm:ss'));
        onChange('custom');
      },
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    });
  }, [startDate, endDate]);

  useEffect(() => {
    return bind(document, {
      type: 'keydown',
      listener(event) {
        if (shouldIgnoreKeypress(event)) {
          return;
        }

        if (isDateRangerPickerOpen.current) {
          return;
        }

        const match = VISIBLE_RANGES.map((k) => timeWindows[k]).find(
          (tw) => tw.shortcut && event.key === tw.shortcut.toLowerCase(),
        );
        if (match?.key === 'custom') {
          handleCustom();
        } else if (match) {
          onChange(match.key);
        }
      },
    });
  }, [handleCustom]);

  if (segmented) {
    const segments: IChartRange[] = ['today', 'yesterday', '7d', '30d', '3m'];
    const shortLabel: Partial<Record<IChartRange, string>> = {
      today: 'Today',
      yesterday: 'Yesterday',
      '7d': '7D',
      '30d': '30D',
      '3m': '3M',
    };
    const segmentClass = (active: boolean) =>
      cn(
        'flex h-full items-center rounded-md px-2.5 text-sm font-medium transition-colors',
        active
          ? 'bg-def-200 text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      );
    return (
      <div
        className={cn(
          'inline-flex h-8 items-center gap-0.5 rounded-lg border p-0.5',
          className,
        )}
      >
        {segments.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={segmentClass(value === key)}
          >
            {shortLabel[key]}
          </button>
        ))}
        <button
          type="button"
          onClick={handleCustom}
          className={cn(
            segmentClass(value === 'custom'),
            'flex items-center gap-1',
          )}
        >
          <CalendarIcon size={14} />
          Custom
        </button>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          icon={CalendarIcon}
          className={cn('justify-start', className)}
        >
          {timeWindow?.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>Time window</DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onChange(timeWindows.lastHour.key)}>
            {timeWindows.lastHour.label}
            <DropdownMenuShortcut>
              {timeWindows.lastHour.shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange(timeWindows.today.key)}>
            {timeWindows.today.label}
            <DropdownMenuShortcut>
              {timeWindows.today.shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange(timeWindows.yesterday.key)}>
            {timeWindows.yesterday.label}
            <DropdownMenuShortcut>
              {timeWindows.yesterday.shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onChange(timeWindows['3d'].key)}>
            {timeWindows['3d'].label}
            <DropdownMenuShortcut>
              {timeWindows['3d'].shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange(timeWindows['7d'].key)}>
            {timeWindows['7d'].label}
            <DropdownMenuShortcut>
              {timeWindows['7d'].shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange(timeWindows['30d'].key)}>
            {timeWindows['30d'].label}
            <DropdownMenuShortcut>
              {timeWindows['30d'].shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange(timeWindows['3m'].key)}>
            {timeWindows['3m'].label}
            <DropdownMenuShortcut>
              {timeWindows['3m'].shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => handleCustom()}>
            {timeWindows.custom.label}
            <DropdownMenuShortcut>
              {timeWindows.custom.shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
