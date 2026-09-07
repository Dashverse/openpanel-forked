import { FilterPropertyPicker } from '@/components/filter-property-picker';
import { Button } from '@/components/ui/button';
import { ComboboxAdvanced } from '@/components/ui/combobox-advanced';
import { DropdownMenuComposed } from '@/components/ui/dropdown-menu';
import { useAppParams } from '@/hooks/use-app-params';
import { useCohorts } from '@/hooks/use-cohorts';
import { useDispatch } from '@/redux';
import type {
  IChartEvent,
  IChartEventFilter,
  IChartEventFilterOperator,
} from '@openpanel/validation';
import { SlidersHorizontal, Trash } from 'lucide-react';
import { changeEvent } from '../../reportSlice';

interface CohortFilterItemProps {
  event: IChartEvent;
  filter: IChartEventFilter;
}

interface PureCohortFilterItemProps {
  filter: IChartEventFilter;
  eventName?: string;
  onChangeProperty: (filter: IChartEventFilter) => void;
  onRemove: (filter: IChartEventFilter) => void;
  onChangeOperator: (
    operator: IChartEventFilterOperator,
    filter: IChartEventFilter,
  ) => void;
  onChangeCohort: (cohortId: string, filter: IChartEventFilter) => void;
  className?: string;
}

export function CohortFilterItem({ filter, event }: CohortFilterItemProps) {
  const dispatch = useDispatch();

  const onRemove = ({ id }: IChartEventFilter) => {
    dispatch(
      changeEvent({
        ...event,
        filters: event.filters.filter((item) => item.id !== id),
        type: 'event',
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
              operator,
            };
          }

          return item;
        }),
      }),
    );
  };

  const onChangeCohort = (cohortId: string, { id }: IChartEventFilter) => {
    dispatch(
      changeEvent({
        ...event,
        type: 'event',
        filters: event.filters.map((item) => {
          if (item.id === id) {
            return {
              ...item,
              name: `cohort:${cohortId}`,
              cohortId,
            };
          }

          return item;
        }),
      }),
    );
  };

  return (
    <PureCohortFilterItem
      filter={filter}
      eventName={event.name}
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
      onChangeOperator={onChangeOperator}
      onChangeCohort={onChangeCohort}
      className="px-4 py-2 shadow-[inset_6px_0_0] shadow-def-300"
    />
  );
}

export function PureCohortFilterItem({
  filter,
  onRemove,
  onChangeOperator,
  onChangeCohort,
  className,
  eventName,
  onChangeProperty,
}: PureCohortFilterItemProps) {
  const { projectId } = useAppParams();

  const { items: cohorts } = useCohorts({ projectId, includeCount: false });

  // Older/saved filters may only carry the id inside the name (cohort:<id>).
  const cohortId = filter.cohortId ?? filter.name.split(':')[1];

  const cohortsCombobox = cohorts.map((cohort) => ({
    value: cohort.id,
    label: cohort.name,
  }));

  const removeFilter = () => {
    onRemove(filter);
  };

  const changeFilterOperator = (operator: IChartEventFilterOperator) => {
    onChangeOperator(operator, filter);
  };

  const changeCohort = (cohortIds: Array<string | number>) => {
    const cohortId = cohortIds[0];
    if (cohortId && typeof cohortId === 'string') {
      onChangeCohort(cohortId, filter);
    }
  };

  return (
    <div className={className}>
      <div className="mb-2 flex items-center gap-2">
        <SlidersHorizontal
          size={14}
          className="shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <FilterPropertyPicker
            projectId={projectId}
            event={eventName}
            filter={filter}
            label="Cohort"
            onChange={onChangeProperty}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          aria-label="Remove filter"
          onClick={removeFilter}
        >
          <Trash size={16} />
        </Button>
      </div>
      <div className="flex gap-1">
        <DropdownMenuComposed
          onChange={changeFilterOperator}
          items={[
            { value: 'inCohort', label: 'In cohort' },
            { value: 'notInCohort', label: 'Not in cohort' },
          ]}
          label="Operator"
        >
          <Button variant={'outline'} className="whitespace-nowrap">
            {filter.operator === 'inCohort' ? 'In cohort' : 'Not in cohort'}
          </Button>
        </DropdownMenuComposed>
        <ComboboxAdvanced
          items={cohortsCombobox}
          value={cohortId ? [cohortId] : []}
          className="flex-1"
          onChange={changeCohort}
          placeholder="Select cohort..."
        />
      </div>
    </div>
  );
}
