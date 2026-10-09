import { Button } from '@/components/ui/button';
import { DropdownMenuComposed } from '@/components/ui/dropdown-menu';
import { useDispatch } from '@/redux';
import type { IChartEvent } from '@openpanel/validation';

import { changeEvent } from '../../reportSlice';
import { CohortFilterItem } from './CohortFilterItem';
import { FilterItem } from './FilterItem';

interface ReportEventFiltersProps {
  event: IChartEvent;
  /**
   * Retention stores its selected event name(s) in a special `filters[0]`
   * entry (`name: 'name'`), not in `event.name`. When true, that name selector
   * is hidden so only real property filters (added via "Add filter") render.
   */
  hideNameFilter?: boolean;
}

export function FiltersList({
  event,
  hideNameFilter,
}: ReportEventFiltersProps) {
  const dispatch = useDispatch();
  const filters = hideNameFilter
    ? event.filters.filter((f) => f.name !== 'name')
    : event.filters;

  if (filters.length === 0) {
    return null;
  }

  // Match all / any only combines property filters; cohort filters always apply.
  const propertyFilterCount = filters.filter(
    (f) => f.operator !== 'inCohort' && f.operator !== 'notInCohort',
  ).length;

  return (
    <div className="flex flex-col gap-1">
      {propertyFilterCount >= 2 && (
        <DropdownMenuComposed
          onChange={(filterOperator) =>
            dispatch(changeEvent({ ...event, type: 'event', filterOperator }))
          }
          items={[
            { value: 'and' as const, label: 'Match all filters' },
            { value: 'or' as const, label: 'Match any filter' },
          ]}
          label="Cohort filters always apply."
        >
          <Button
            variant="ghost"
            size="sm"
            className="self-start text-muted-foreground"
            title="Cohort filters always apply."
          >
            {event.filterOperator === 'or' ? 'Match any' : 'Match all'}
          </Button>
        </DropdownMenuComposed>
      )}
      <div className="flex flex-col divide-y overflow-hidden rounded-md border">
        {filters.map((filter) => {
          // Use CohortFilterItem for cohort filters
          const isCohortFilter =
            filter.operator === 'inCohort' || filter.operator === 'notInCohort';

          if (isCohortFilter) {
            return (
              <CohortFilterItem key={filter.id} filter={filter} event={event} />
            );
          }

          return <FilterItem key={filter.id} filter={filter} event={event} />;
        })}
      </div>
    </div>
  );
}
