import type { IChartEvent } from '@openpanel/validation';

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
  const filters = hideNameFilter
    ? event.filters.filter((f) => f.name !== 'name')
    : event.filters;

  if (filters.length === 0) {
    return null;
  }

  return (
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
  );
}
