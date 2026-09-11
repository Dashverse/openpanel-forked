import { FilterPropertyPicker } from '@/components/filter-property-picker';
import { Button } from '@/components/ui/button';
import { ComboboxAdvanced } from '@/components/ui/combobox-advanced';
import { DropdownMenuComposed } from '@/components/ui/dropdown-menu';
import { InputEnter } from '@/components/ui/input-enter';
import { usePropertyValues } from '@/hooks/use-property-values';
import { cn } from '@/utils/cn';
import { operators } from '@openpanel/constants';
import type {
  IChartEventFilter,
  IChartEventFilterOperator,
  IChartEventFilterValue,
} from '@openpanel/validation';
import { mapKeys } from '@openpanel/validation';
import { Trash2 } from 'lucide-react';

interface FilterRowProps {
  projectId: string;
  event?: string;
  filter: IChartEventFilter;
  onChangeOperator: (operator: IChartEventFilterOperator) => void;
  onChangeValue: (value: IChartEventFilterValue[]) => void;
  onRemove: () => void;
  onChangeProperty: (filter: IChartEventFilter) => void;
  exclude?: string[];
  /**
   * Width classes for the value control. Defaults to the fixed `w-[220px]` the
   * Events page uses; pass a size-to-content variant (e.g.
   * `min-w-[8rem] max-w-[16rem] w-auto`) on the dashboard filter bar.
   */
  valueClassName?: string;
  /**
   * Extra classes for the row container. Defaults to the Events-page grouping
   * gap (`gap-1.5`); the dashboard filter bar passes `gap-2` so the filter
   * controls read as one strip with the date/interval controls.
   */
  className?: string;
  /**
   * Collapse the multi-value control to the first N chips + "+X more" on one
   * line (Mixpanel-style) instead of wrapping every selected value. Omit for
   * the Events-page default (wrap all chips).
   */
  valueMaxVisibleChips?: number;
}

export function FilterRow({
  projectId,
  event,
  filter,
  onChangeOperator,
  onChangeValue,
  onRemove,
  onChangeProperty,
  exclude,
  valueClassName = 'w-[220px]',
  className,
  valueMaxVisibleChips,
}: FilterRowProps) {
  const potentialValues = usePropertyValues({
    event,
    property: filter.name,
    projectId,
  });

  const valuesCombobox = potentialValues.map((item) => ({
    value: item,
    label: item,
  }));

  const isValueSelect = filter.operator === 'is' || filter.operator === 'isNot';
  const isNoValue =
    filter.operator === 'isNull' || filter.operator === 'isNotNull';

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <FilterPropertyPicker
        projectId={projectId}
        filter={filter}
        onChange={onChangeProperty}
        exclude={exclude}
        event={event}
      />
      <DropdownMenuComposed
        onChange={onChangeOperator}
        items={mapKeys(operators)
          .filter((key) => key !== 'inCohort' && key !== 'notInCohort')
          .map((key) => ({
            value: key,
            label: operators[key],
          }))}
        label="Operator"
      >
        <Button variant="outline" size="sm" className="whitespace-nowrap">
          {operators[filter.operator]}
        </Button>
      </DropdownMenuComposed>
      {isNoValue ? null : isValueSelect ? (
        <ComboboxAdvanced
          key={filter.name}
          items={valuesCombobox}
          value={filter.value}
          className={valueClassName}
          size="sm"
          onChange={onChangeValue}
          placeholder="Select..."
          maxVisibleChips={valueMaxVisibleChips}
        />
      ) : (
        <div className={valueClassName}>
          <InputEnter
            key={filter.name}
            className="h-8"
            value={filter.value[0] ? String(filter.value[0]) : ''}
            onChangeValue={(value) => onChangeValue([value])}
          />
        </div>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Remove filter"
        onClick={onRemove}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}
