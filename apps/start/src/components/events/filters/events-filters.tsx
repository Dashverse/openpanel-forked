import { PropertyPicker } from '@/components/property-picker';
import { Button } from '@/components/ui/button';
import { ComboboxEvents } from '@/components/ui/combobox-events';
import { useAppParams } from '@/hooks/use-app-params';
import { useEventNames } from '@/hooks/use-event-names';
import {
  useEventQueryFilters,
  useEventQueryNamesFilter,
} from '@/hooks/use-event-query-filters';
import { PlusIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { CohortFilterRow } from './cohort-filter-row';
import { FilterRow } from './filter-row';

export function EventsFilters({
  rangeSlot,
  // Label above the event picker. Defaults to "Select event"; the Profiles page
  // overrides it to "Profiles who did" (Mixpanel-style phrasing).
  eventLabel = 'Select event',
  // Rendered inline right after the event combobox — the Profiles page puts the
  // "≥ N times" threshold control here.
  afterEventSlot,
}: {
  rangeSlot?: ReactNode;
  eventLabel?: string;
  afterEventSlot?: ReactNode;
} = {}) {
  const { projectId } = useAppParams();
  const [filters, setFilter, , removeFilter] = useEventQueryFilters();
  const [events, setEvents] = useEventQueryNamesFilter();
  const {
    items: eventNames,
    isLoading,
    isError,
    refetch,
  } = useEventNames({ projectId });

  const selectedEvent = events.length === 1 ? events[0] : undefined;

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-semibold uppercase text-muted-foreground">
          {eventLabel}
        </span>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ComboboxEvents
              size="sm"
              className="w-full max-w-xs"
              value={events}
              onChange={setEvents}
              multiple
              items={eventNames}
              placeholder="All Events"
              maxDisplayItems={2}
              searchable
              isLoading={isLoading}
              isError={isError}
              onRefresh={refetch}
            />
            {afterEventSlot}
          </div>
          {rangeSlot}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[10px] font-semibold uppercase text-muted-foreground">
          Filters
        </span>
        {filters.map((filter) => {
          const isCohort =
            filter.operator === 'inCohort' ||
            filter.operator === 'notInCohort' ||
            filter.name.startsWith('cohort:');

          if (isCohort) {
            return (
              <CohortFilterRow
                key={filter.name}
                projectId={projectId}
                filter={filter}
                onChangeOperator={(operator) => {
                  if (operator !== filter.operator) {
                    setFilter(filter.name, filter.value, operator);
                  }
                }}
                onRemove={() => removeFilter(filter.name)}
              />
            );
          }

          return (
            <FilterRow
              key={filter.name}
              projectId={projectId}
              event={selectedEvent}
              filter={filter}
              onChangeOperator={(operator) => {
                if (operator !== filter.operator) {
                  setFilter(filter.name, filter.value, operator);
                }
              }}
              onChangeValue={(value) =>
                setFilter(filter.name, value, filter.operator)
              }
              onRemove={() => removeFilter(filter.name)}
            />
          );
        })}
        <div>
          <PropertyPicker
            projectId={projectId}
            event={selectedEvent}
            onSelect={(action) =>
              setFilter(action.value, [], action.cohortId ? 'inCohort' : 'is')
            }
          >
            <Button
              variant="outline"
              size="sm"
              icon={PlusIcon}
              className="border-dashed"
            >
              Add
            </Button>
          </PropertyPicker>
        </div>
      </div>
    </div>
  );
}
