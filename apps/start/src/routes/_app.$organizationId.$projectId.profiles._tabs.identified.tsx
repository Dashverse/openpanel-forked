import { EventsFilters } from '@/components/events/filters/events-filters';
import { OverviewRange } from '@/components/overview/overview-range';
import { useOverviewOptions } from '@/components/overview/useOverviewOptions';
import { ProfilesTable } from '@/components/profiles/table';
import { useDataTablePagination } from '@/components/ui/data-table/data-table-hooks';
import {
  useEventQueryFilters,
  useEventQueryNamesFilter,
} from '@/hooks/use-event-query-filters';
import { useSearchQueryState } from '@/hooks/use-search-query-state';
import { useTRPC } from '@/integrations/trpc/react';
import { PAGE_TITLES, createEntityTitle } from '@/utils/title';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/profiles/_tabs/identified',
)({
  head: () => {
    return {
      meta: [
        {
          title: createEntityTitle('Identified', PAGE_TITLES.PROFILES),
        },
      ],
    };
  },
  component: Component,
});

function Component() {
  const { projectId } = Route.useParams();
  const trpc = useTRPC();

  const { page } = useDataTablePagination(50);
  const { debouncedSearch } = useSearchQueryState();
  const [filters] = useEventQueryFilters();
  const [events] = useEventQueryNamesFilter();
  const { range, startDate, endDate } = useOverviewOptions();

  const query = useQuery(
    trpc.profile.list.queryOptions(
      {
        cursor: (page - 1) * 50,
        projectId,
        take: 50,
        search: debouncedSearch,
        isExternal: true,
        filters,
        events,
        range,
        startDate,
        endDate,
      },
      {
        placeholderData: keepPreviousData,
      },
    ),
  );

  const count = query.data?.meta.count;
  // `['*']` is the "All Events" wildcard — not a real behavioral selection, so
  // the date range (which only bounds the behavioral filter) shouldn't show.
  const hasEventSelected = events.some((e) => e && e !== '*');

  return (
    <div className="flex flex-col gap-4">
      {/* Total (or filtered) profile count — Mixpanel-style, top-left. Prominent
          and flush-left with the title/card. Skeleton while (re)fetching so it
          visibly tracks the filter. */}
      <div className="flex h-7 items-baseline gap-1.5 tabular-nums">
        {query.isFetching ? (
          <span className="h-6 w-40 self-center animate-pulse rounded bg-muted" />
        ) : typeof count === 'number' ? (
          <>
            <span className="text-lg font-semibold text-foreground">
              {count.toLocaleString()}
            </span>
            <span className="text-sm font-medium text-muted-foreground">
              profiles
            </span>
          </>
        ) : null}
      </div>
      {/* Date range lives inside the filter card, next to the event selector,
          and only when an event is selected (it only bounds the behavioral
          filter — otherwise a default like "Today" is misleading). */}
      <EventsFilters
        rangeSlot={hasEventSelected ? <OverviewRange /> : undefined}
      />
      <ProfilesTable type="profiles" query={query} />
    </div>
  );
}
