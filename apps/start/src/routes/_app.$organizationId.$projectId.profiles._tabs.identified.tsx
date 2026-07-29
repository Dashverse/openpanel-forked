import { EventsFilters } from '@/components/events/filters/events-filters';
import { EventCountFilter } from '@/components/profiles/event-count-filter';
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
import { format, subDays } from 'date-fns';
import { useMemo, useState } from 'react';

const DB_FORMAT = 'yyyy-MM-dd HH:mm:ss';

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
  const {
    dir,
    seenStart,
    seenEnd,
    countOp,
    setCountOp,
    countVal,
    setCountVal,
    countVal2,
    setCountVal2,
  } = useProfilesSort();

  // Only query on COMPLETE filters (name + a chosen value). Adding a filter row
  // (e.g. "source") with no value yet shouldn't trigger a load — wait until the
  // user picks a value. Incomplete filters are ignored server-side anyway, so
  // dropping them here keeps the React Query key stable → no premature refetch.
  const activeFilters = useMemo(
    () => filters.filter((f) => f.name && f.value?.length),
    [filters],
  );

  // Default the "Last seen" window to the last 15 days (ending now) when the
  // user hasn't picked one. A window ending *now* keeps last-seen times real —
  // v2's day-granular last-event only reads oddly for windows ending mid-day in
  // the past. Stable per mount so it doesn't churn the query key.
  const [defaultWindow] = useState(() => ({
    start: format(subDays(new Date(), 15), DB_FORMAT),
    end: format(new Date(), DB_FORMAT),
  }));
  const rangeStart = seenStart ?? defaultWindow.start;
  const rangeEnd = seenEnd ?? defaultWindow.end;

  const hasEvent = events.some((e) => e && e !== '*');

  // Build the "did event OP N times" payload. Only sent when an event is
  // selected; a missing operator defaults to "at least 1" (server treats as
  // no-op). Stable identity so the query key doesn't churn.
  const op = countOp ?? 'gte';
  const val = countVal ?? 1;
  const val2 = countVal2 ?? val + 1;
  const eventCount = useMemo(
    () =>
      hasEvent
        ? {
            operator: op,
            value: val,
            ...(op === 'between' || op === 'notBetween'
              ? { value2: val2 }
              : {}),
          }
        : undefined,
    [hasEvent, op, val, val2],
  );

  const query = useQuery(
    trpc.profile.list.queryOptions(
      {
        cursor: (page - 1) * 50,
        projectId,
        take: 50,
        search: debouncedSearch,
        // No is_external filter: this page is ALL profiles (anonymous +
        // identified). The behavioral count already includes anonymous, so
        // filtering the base to identified-only made the two inconsistent
        // (adding an event filter could raise the count above the base).
        filters: activeFilters,
        events,
        // Single date control (defaulted to last 15 days): the "Last seen"
        // window bounds both the profile list (created_at) and the behavioral
        // event subquery.
        startDate: rangeStart,
        endDate: rangeEnd,
        lastSeenDir: dir === 'asc' ? 'ASC' : 'DESC',
        lastSeenStart: rangeStart,
        lastSeenEnd: rangeEnd,
        // "did event OP N times" — only sent when an event is selected.
        eventCount,
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
      <EventsFilters
        eventLabel="Profiles who did"
        afterEventSlot={
          hasEvent ? (
            <EventCountFilter
              operator={op}
              value={val}
              value2={val2}
              onOperatorChange={setCountOp}
              onValueChange={setCountVal}
              onValue2Change={setCountVal2}
            />
          ) : null
        }
      />
      <ProfilesTable type="profiles" query={query} />
    </div>
  );
}
