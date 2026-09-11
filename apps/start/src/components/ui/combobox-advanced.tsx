import { Badge } from '@/components/ui/badge';
import { Command, CommandInput, CommandItem } from '@/components/ui/command';
import { cn } from '@/utils/cn';
import { ChevronsUpDownIcon } from 'lucide-react';
import VirtualList from 'rc-virtual-list';
import * as React from 'react';
import { useOnClickOutside } from 'usehooks-ts';

import { Button, type ButtonProps } from './button';
import { Checkbox, DumpCheckbox } from './checkbox';
import {
  Popover,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from './popover';

type IValue = any;
type IItem = Record<'value' | 'label', IValue>;

const sanitize = (value: string) => {
  return encodeURIComponent(value.replaceAll('"', '&quot;'));
};

const desanitize = (value: string) => {
  return decodeURIComponent(value).replaceAll('&quot;', '"');
};

interface ComboboxAdvancedProps {
  value: IValue[];
  onChange: (value: IValue[]) => void;
  items: IItem[];
  placeholder: string;
  className?: string;
  size?: ButtonProps['size'];
  keepSearchOnSelect?: boolean;
  /**
   * When set, the trigger collapses to the first N selected chips plus a
   * "+X more" badge on a single line, instead of wrapping every chip (which
   * balloons the control vertically). Used by the dashboard filter bar so many
   * selected values stay on one clean strip. Omit for the Events-page default
   * (wrap all chips).
   */
  maxVisibleChips?: number;
}

export function ComboboxAdvanced({
  items,
  value,
  onChange,
  placeholder,
  className,
  size,
  keepSearchOnSelect,
  maxVisibleChips,
}: ComboboxAdvancedProps) {
  const [open, setOpen] = React.useState(false);
  const [inputValue, setInputValue] = React.useState('');
  const ref = React.useRef<HTMLDivElement>(null);
  useOnClickOutside(ref as React.RefObject<HTMLElement>, () => setOpen(false));

  const selectables = items
    .filter((item) => !value.find((s) => s === item.value))
    .filter(
      (item) =>
        (typeof item.label === 'string' &&
          item.label.toLowerCase().includes(inputValue.toLowerCase())) ||
        (typeof item.value === 'string' &&
          item.value.toLowerCase().includes(inputValue.toLowerCase())),
    );

  const renderItem = (item: IItem) => {
    const checked = !!value.find((s) => s === desanitize(item.value));
    return (
      <CommandItem
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onSelect={() => {
          if (!keepSearchOnSelect) {
            setInputValue('');
          }
          onChange(
            value.includes(desanitize(item.value))
              ? value.filter((s) => s !== desanitize(item.value))
              : [...value, desanitize(item.value)],
          );
        }}
        className={'flex cursor-pointer items-center gap-2'}
        value={item.value}
      >
        <DumpCheckbox checked={checked} />
        {desanitize(item?.label ?? item?.value)}
      </CommandItem>
    );
  };

  const data = React.useMemo(() => {
    return [
      ...(inputValue === ''
        ? []
        : [
            {
              value: inputValue,
              label: `Pick '${inputValue}'`,
            },
          ]),
      ...value.map((val) => {
        const item = items.find((item) => item.value === val);
        return item
          ? {
              value: val,
              label: item.label,
            }
          : {
              value: val,
              label: val,
            };
      }),
      ...selectables,
    ].filter((item) => item.value);
  }, [inputValue, selectables, items]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={'outline'}
          onClick={() => setOpen((prev) => !prev)}
          className={className}
          size={size}
          autoHeight
        >
          <div
            className={cn(
              'flex w-full min-w-0 gap-1',
              maxVisibleChips
                ? 'flex-nowrap items-center overflow-hidden'
                : 'flex-wrap',
            )}
          >
            {value.length === 0 && placeholder}
            {(maxVisibleChips && value.length > maxVisibleChips
              ? value.slice(0, maxVisibleChips)
              : value
            ).map((value) => {
              const item = items.find((item) => item.value === value) ?? {
                value,
                label: value,
              };
              return (
                <Badge
                  variant="secondary"
                  key={String(item.value)}
                  className={maxVisibleChips ? 'max-w-[8rem] shrink-0' : ''}
                >
                  <span className={maxVisibleChips ? 'truncate' : ''}>
                    {item.label}
                  </span>
                </Badge>
              );
            })}
            {maxVisibleChips && value.length > maxVisibleChips && (
              <Badge variant="secondary" className="shrink-0 whitespace-nowrap">
                +{value.length - maxVisibleChips} more
              </Badge>
            )}
          </div>
          <ChevronsUpDownIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent className="w-full max-w-md p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search"
              value={inputValue}
              onValueChange={setInputValue}
            />
            <VirtualList
              height={Math.min(items.length * 32, 300)}
              data={data.map((item) => ({
                ...item,
                label: sanitize(item.label),
                value: sanitize(item.value),
              }))}
              itemHeight={32}
              itemKey="value"
            >
              {renderItem}
            </VirtualList>
          </Command>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
