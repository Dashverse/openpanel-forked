import { PropertyPicker } from '@/components/property-picker';
import { RenderDots } from '@/components/ui/RenderDots';
import { Button } from '@/components/ui/button';
import type { IChartEventFilter } from '@openpanel/validation';
import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';

export type FilterPropertyPickerProps = Pick<
  ComponentProps<typeof PropertyPicker>,
  'projectId' | 'event' | 'categories' | 'exclude'
> & {
  filter: IChartEventFilter;
  onChange: (filter: IChartEventFilter) => void;
  label?: string;
};

export function FilterPropertyPicker({
  filter,
  onChange,
  label = filter.name,
  ...props
}: FilterPropertyPickerProps) {
  return (
    <PropertyPicker
      {...props}
      onSelect={(action) => {
        if (action.value === filter.name) return;
        onChange({
          ...filter,
          name: action.value,
          operator: action.cohortId ? 'inCohort' : 'is',
          value: [],
          cohortId: action.cohortId,
        });
      }}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-w-0 max-w-[28rem] justify-start gap-2"
        aria-label={`Change filter property: ${label}`}
      >
        <RenderDots className="min-w-0 truncate" truncate>
          {label}
        </RenderDots>
        <ChevronDown className="size-3 shrink-0" />
      </Button>
    </PropertyPicker>
  );
}
