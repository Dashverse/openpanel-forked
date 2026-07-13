import { EventsFilters } from '@/components/events/filters/events-filters';
import { LastSeenRange } from '@/components/profiles/last-seen-range';
import { ProfilesTable } from '@/components/profiles/table';
import { useDataTablePagination } from '@/components/ui/data-table/data-table-hooks';
import {
  useEventQueryFilters,
  useEventQueryNamesFilter,
} from '@/hooks/use-event-query-filters';
import { useProfilesSort } from '@/hooks/use-profiles-sort';
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
  const { dir, seenStart, seenEnd } = useProfilesSort();

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
        // Single date control: the "Last seen" window bounds both the profile
        // list (created_at) and the behavioral event subquery.
        startDate: seenStart,
        endDate: seenEnd,
        lastSeenDir: dir === 'asc' ? 'ASC' : 'DESC',
        lastSeenStart: seenStart,
        lastSeenEnd: seenEnd,
      },
      {
        placeholderData: keepPreviousData,
      },
    ),
  );

  const count = query.data?.meta.count;

  return (
    <div className="flex flex-col gap-4">
      {/* Count (Mixpanel-style, top-left) + the "Last seen" window control on
          the right. Skeleton while (re)fetching so the count tracks the filter. */}
      <div className="flex h-7 items-center justify-between gap-2">
        <div className="flex items-baseline gap-1.5 tabular-nums">
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
        <LastSeenRange />
      </div>
      <EventsFilters />
      <ProfilesTable type="profiles" query={query} />
    </div>
  );
}
