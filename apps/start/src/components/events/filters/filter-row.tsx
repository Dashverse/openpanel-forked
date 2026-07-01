import { RenderDots } from '@/components/ui/RenderDots';
import { Button } from '@/components/ui/button';
import { ComboboxAdvanced } from '@/components/ui/combobox-advanced';
import { DropdownMenuComposed } from '@/components/ui/dropdown-menu';
import { InputEnter } from '@/components/ui/input-enter';
import { usePropertyValues } from '@/hooks/use-property-values';
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
}

export function FilterRow({
  projectId,
  event,
  filter,
  onChangeOperator,
  onChangeValue,
  onRemove,
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
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="flex h-8 w-fit min-w-0 max-w-[28rem] items-center overflow-hidden rounded-md border bg-background px-2.5 text-sm font-medium">
        <RenderDots className="min-w-0 truncate" truncate>
          {filter.name}
        </RenderDots>
      </div>
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
          items={valuesCombobox}
          value={filter.value}
          className="w-[220px]"
          size="sm"
          onChange={onChangeValue}
          placeholder="Select..."
        />
      ) : (
        <div className="w-[220px]">
          <InputEnter
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
