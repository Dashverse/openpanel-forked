import { EventsTable } from '@/components/events/table';
import { useReadColumnVisibility } from '@/components/ui/data-table/data-table-hooks';
import {
  useEventQueryFilters,
  useEventQueryNamesFilter,
} from '@/hooks/use-event-query-filters';
import { useTRPC } from '@/integrations/trpc/react';
import { PAGE_TITLES, createProjectTitle } from '@/utils/title';
import { useInfiniteQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { subDays } from 'date-fns';
import { parseAsIsoDateTime, useQueryState } from 'nuqs';
import { useMemo } from 'react';

// Default the profile events feed to the last 15 days (like the profiles list,
// #371) so landing on a busy profile stays fast. A user-picked range wins, and
// when searching a specific event we span all days (no default window) so old
// events are found.
const DEFAULT_WINDOW_DAYS = 15;

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/profiles/$profileId/_tabs/events',
)({
  component: Component,
  head: () => {
    return {
      meta: [
        {
          title: createProjectTitle(PAGE_TITLES.PROFILE_EVENTS),
        },
      ],
    };
  },
});

function Component() {
  const { projectId, profileId } = Route.useParams();
  const trpc = useTRPC();
  const [filters] = useEventQueryFilters();
  const [startDate] = useQueryState('startDate', parseAsIsoDateTime);
  const [endDate] = useQueryState('endDate', parseAsIsoDateTime);
  const [eventNames] = useEventQueryNamesFilter();
  const columnVisibility = useReadColumnVisibility('events');

  const isSearching = (eventNames?.length ?? 0) > 0;
  // A user-picked range always wins (a lone start = "since" gets `now` as end).
  // Otherwise: searching a specific event spans all days; the default feed is the
  // last 15 days. Memoized so the "now" anchor is stable across renders.
  const { rangeStart, rangeEnd } = useMemo(() => {
    if (startDate) {
      return { rangeStart: startDate, rangeEnd: endDate ?? new Date() };
    }
    if (isSearching) {
      return { rangeStart: undefined, rangeEnd: undefined };
    }
    const now = new Date();
    return { rangeStart: subDays(now, DEFAULT_WINDOW_DAYS), rangeEnd: now };
  }, [startDate, endDate, isSearching]);

  const query = useInfiniteQuery(
    trpc.event.events.infiniteQueryOptions(
      {
        projectId,
        profileId,
        // Show the full journey: identified profile + its anonymous device
        // aliases merged into one timeline (pre-login events live under the
        // anon device id, resolved via profile_aliases).
        mergeIdentity: true,
        filters,
        startDate: rangeStart,
        endDate: rangeEnd,
        events: eventNames,
        columnVisibility: columnVisibility ?? {},
      },
      {
        enabled: columnVisibility !== null,
        getNextPageParam: (lastPage) => lastPage.meta.next,
      },
    ),
  );

  return (
    <EventsTable
      query={query}
      emptyRangeLabel={isSearching ? 'All time' : 'Last 15 days'}
    />
  );
}
