import type { IChartEvent } from '@openpanel/validation';

import { CohortFilterItem } from './CohortFilterItem';
import { FilterItem } from './FilterItem';

interface ReportEventFiltersProps {
  event: IChartEvent;
}

export function FiltersList({ event }: ReportEventFiltersProps) {
  if (event.filters.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col divide-y overflow-hidden rounded-md border">
      {event.filters.map((filter) => {
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
