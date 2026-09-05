import {
  FilterPropertyPicker,
  type FilterPropertyPickerProps,
} from '@/components/filter-property-picker';
import { Button } from '@/components/ui/button';
import { ComboboxAdvanced } from '@/components/ui/combobox-advanced';
import { DropdownMenuComposed } from '@/components/ui/dropdown-menu';
import { InputEnter } from '@/components/ui/input-enter';
import { useAppParams } from '@/hooks/use-app-params';
import { usePropertyValues } from '@/hooks/use-property-values';
import { useDispatch } from '@/redux';
import { operators } from '@openpanel/constants';
import type {
  IChartEvent,
  IChartEventFilter,
  IChartEventFilterOperator,
  IChartEventFilterValue,
} from '@openpanel/validation';
import { mapKeys } from '@openpanel/validation';
import { SlidersHorizontal, Trash } from 'lucide-react';
import { changeEvent } from '../../reportSlice';

interface FilterProps {
  event: IChartEvent;
  filter: IChartEventFilter;
}

interface PureFilterProps {
  eventName: string;
  onChangeProperty: (filter: IChartEventFilter) => void;
  categories?: FilterPropertyPickerProps['categories'];
  exclude?: string[];
  filter: IChartEventFilter;
  onRemove: (filter: IChartEventFilter) => void;
  onChangeValue: (
    value: IChartEventFilterValue[],
    filter: IChartEventFilter,
  ) => void;
  onChangeOperator: (
    operator: IChartEventFilterOperator,
    filter: IChartEventFilter,
  ) => void;
  className?: string;
}

export function FilterItem({ filter, event }: FilterProps) {
  const onRemove = ({ id }: IChartEventFilter) => {
    dispatch(
      changeEvent({
        ...event,
        filters: event.filters.filter((item) => item.id !== id),
        type: 'event',
      }),
    );
  };

  const onChangeValue = (
    value: IChartEventFilterValue[],
    { id }: IChartEventFilter,
  ) => {
    dispatch(
      changeEvent({
        ...event,
        type: 'event',
        filters: event.filters.map((item) => {
          if (item.id === id) {
            return {
              ...item,
              value,
            };
          }

          return item;
        }),
      }),
    );
  };

  const onChangeOperator = (
    operator: IChartEventFilterOperator,
    { id }: IChartEventFilter,
  ) => {
    dispatch(
      changeEvent({
        ...event,
        type: 'event',
        filters: event.filters.map((item) => {
          if (item.id === id) {
            return {
              ...item,
              value: item.value ? item.value.filter(Boolean).slice(0, 1) : [],
              operator,
            };
          }

          return item;
        }),
      }),
    );
  };

  const dispatch = useDispatch();
  return (
    <PureFilterItem
      filter={filter}
      eventName={event.name}
      categories={['event', 'profile', 'cohort']}
      onChangeProperty={(next) =>
        dispatch(
          changeEvent({
            ...event,
            type: 'event',
            filters: event.filters.map((item) =>
              item.id === next.id ? next : item,
            ),
          }),
        )
      }
      onRemove={onRemove}
      onChangeValue={onChangeValue}
      onChangeOperator={onChangeOperator}
      className="px-4 py-2 shadow-[inset_6px_0_0] shadow-def-300"
    />
  );
}

export function PureFilterItem({
  filter,
  eventName,
  onRemove,
  onChangeValue,
  onChangeOperator,
  className,
  onChangeProperty,
  categories = ['event', 'profile'],
  exclude,
}: PureFilterProps) {
  const { projectId } = useAppParams();

  const potentialValues = usePropertyValues({
    event: eventName,
    property: filter.name,
    projectId,
  });

  const valuesCombobox =
    potentialValues.map((item) => ({
      value: item,
      label: item,
    })) ?? [];

  const removeFilter = () => {
    onRemove(filter);
  };

  const changeFilterValue = (value: IChartEventFilterValue[]) => {
    onChangeValue(value, filter);
  };

  const changeFilterOperator = (operator: IChartEventFilterOperator) => {
    onChangeOperator(operator, filter);
  };

  return (
    <div className={className}>
      <div className="mb-2 flex items-center gap-2">
        <SlidersHorizontal
          size={14}
          className="shrink-0 text-muted-foreground"
        />
        <div className="flex min-w-0 flex-1">
          <FilterPropertyPicker
            projectId={projectId}
            event={eventName || undefined}
            filter={filter}
            onChange={onChangeProperty}
            categories={categories}
            exclude={exclude}
          />
        </div>
        <Button variant="ghost" size="sm" onClick={removeFilter}>
          <Trash size={16} />
        </Button>
      </div>
      <div className="flex gap-1">
        <DropdownMenuComposed
          onChange={changeFilterOperator}
          items={mapKeys(operators)
            .filter((key) => key !== 'inCohort' && key !== 'notInCohort')
            .map((key) => ({
              value: key,
              label: operators[key],
            }))}
          label="Operator"
        >
          <Button variant={'outline'} className="whitespace-nowrap">
            {operators[filter.operator]}
          </Button>
        </DropdownMenuComposed>
        {filter.operator === 'isNull' ||
        filter.operator === 'isNotNull' ? null : filter.operator === 'is' ||
          filter.operator === 'isNot' ? (
          <ComboboxAdvanced
            key={filter.name}
            items={valuesCombobox}
            value={filter.value}
            className="flex-1"
            onChange={changeFilterValue}
            placeholder="Select..."
          />
        ) : (
          <InputEnter
            key={filter.name}
            value={filter.value[0] ? String(filter.value[0]) : ''}
            onChangeValue={(value) => changeFilterValue([value])}
          />
        )}
      </div>
    </div>
  );
}
