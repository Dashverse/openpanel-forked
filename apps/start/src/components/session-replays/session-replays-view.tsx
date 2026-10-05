import { EventsFilters } from '@/components/events/filters/events-filters';
import { ProjectLink } from '@/components/links';
import { ProfileAvatar } from '@/components/profiles/profile-avatar';
import { SerieIcon } from '@/components/report-chart/common/serie-icon';
import { ReplayShell, useReplayShareState } from '@/components/sessions/replay';
import {
  ReplayListToolbar,
  ReplaySessionFiltersCard,
  useReplayListState,
} from './replay-list-filters';
import { formatDuration } from '@/components/sessions/replay/replay-utils';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  useEventQueryFilters,
  useEventQueryNamesFilter,
} from '@/hooks/use-event-query-filters';
import { useSearchQueryState } from '@/hooks/use-search-query-state';
import { useTRPC } from '@/integrations/trpc/react';
import { clipboard } from '@/utils/clipboard';
import { cn } from '@/utils/cn';
import { formatDateTime, formatTimeAgoOrDateTime } from '@/utils/date';
import { getProfileName } from '@/utils/getters';
import type { IServiceProfile, IServiceSession } from '@openpanel/db';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  ExternalLinkIcon,
  FilterIcon,
  LinkIcon,
  Loader2Icon,
  MonitorPlayIcon,
  SearchIcon,
} from 'lucide-react';
import { parseAsInteger, parseAsString, useQueryState } from 'nuqs';
import { useEffect, useMemo, useRef, useState } from 'react';

type ReplaySession = IServiceSession & {
  profile?: IServiceProfile;
  replayTabCount?: number;
};

function sessionName(s: ReplaySession) {
  return (s.profile && getProfileName(s.profile)) || s.profileId || 'Anonymous';
}

/**
 * Small icon row: country · OS · browser (whatever is known). `countryOnly`
 * for list rows, where space is tight. No device icon — it's the same generic
 * monitor on nearly every row and says nothing.
 */
function SessionContextIcons({
  session,
  countryOnly = false,
}: {
  session: ReplaySession;
  countryOnly?: boolean;
}) {
  const all = [
    { key: 'country', value: session.country, label: [session.city, session.country].filter(Boolean).join(', ') },
    { key: 'os', value: session.os, label: [session.os, session.osVersion].filter(Boolean).join(' ') },
    { key: 'browser', value: session.browser, label: [session.browser, session.browserVersion].filter(Boolean).join(' ') },
  ].filter((i) => i.value);
  const items = countryOnly ? all.filter((i) => i.key === 'country') : all;
  if (items.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {items.map((i) => (
        <Tooltip key={i.key}>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <SerieIcon name={i.value} />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{i.label}</TooltipContent>
        </Tooltip>
      ))}
    </span>
  );
}

function ReplayListRow({
  session,
  isActive,
  onSelect,
}: {
  session: ReplaySession;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-replay-id={session.id}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-3 border-b border-l-2 px-3 py-3 text-left transition-colors',
        isActive
          ? 'border-l-primary bg-primary/5'
          : 'border-l-transparent hover:bg-muted/50',
      )}
    >
      <ProfileAvatar
        className="shrink-0"
        size="sm"
        avatar={session.profile?.avatar}
        firstName={session.profile?.firstName}
        lastName={session.profile?.lastName}
        email={session.profile?.email}
        isExternal={session.profile?.isExternal}
        id={session.profileId}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm font-medium',
              isActive && 'text-primary',
            )}
          >
            {sessionName(session)}
          </span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-foreground">
            {formatDuration(session.duration)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            {formatTimeAgoOrDateTime(session.createdAt)} · {session.eventCount}{' '}
            events
            {(session.replayTabCount ?? 0) > 1 &&
              ` · ${session.replayTabCount} tabs`}
          </span>
          <SessionContextIcons session={session} countryOnly />
        </div>
      </div>
    </button>
  );
}

/**
 * Share menu: link to the whole replay, or to the exact moment being watched
 * (same tab + time) — the recipient's player opens paused at that point.
 */
function ReplayShareMenu({ sessionId }: { sessionId: string }) {
  const { windowId, isReady, currentDisplayMs } = useReplayShareState();
  const link = (atTime: boolean) => {
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set('session', sessionId);
    if (atTime) {
      if (windowId) url.searchParams.set('tab', windowId);
      url.searchParams.set('t', String(Math.floor(currentDisplayMs / 1000)));
    }
    return url.toString();
  };
  const at = formatDuration(currentDisplayMs);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5">
          <LinkIcon className="size-3.5" />
          Share
          <ChevronDownIcon className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem
          onSelect={() => clipboard(link(false), 'Link to this replay')}
          className="gap-2"
        >
          <LinkIcon className="size-3.5" />
          Copy link to replay
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!isReady}
          onSelect={() =>
            clipboard(link(true), `Opens this replay at ${at}`)
          }
          className="gap-2"
        >
          <ClockIcon className="size-3.5" />
          Copy link at current time
          <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
            {at}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Icon + label, e.g. [flag] Naaldwijk, NL — for the header's context line. */
function MetaChip({ icon, label }: { icon: string; label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="inline-flex shrink-0 [&_img]:size-3.5 [&_svg]:size-3.5">
        <SerieIcon name={icon} />
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Top of the player column: who, when, how long, where — plus navigation. */
function ReplayHeader({
  session,
  onPrev,
  onNext,
}: {
  session: ReplaySession | undefined;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  if (!session) {
    return <div className="h-[60px] shrink-0 border-b" />;
  }
  return (
    <div className="flex shrink-0 items-center gap-4 border-b px-4 py-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <ProfileAvatar
          className="shrink-0"
          avatar={session.profile?.avatar}
          firstName={session.profile?.firstName}
          lastName={session.profile?.lastName}
          email={session.profile?.email}
          isExternal={session.profile?.isExternal}
          id={session.profileId}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <ProjectLink
            href={`/profiles/${session.profileId}`}
            className="truncate text-sm font-semibold leading-5 hover:underline"
          >
            {sessionName(session)}
          </ProjectLink>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-5 text-muted-foreground">
            <span className="tabular-nums">
              {formatDateTime(session.createdAt)}
              <span aria-hidden className="px-1.5">·</span>
              {formatDuration(session.duration)}
              <span aria-hidden className="px-1.5">·</span>
              {session.eventCount.toLocaleString()} events
            </span>
            {(session.city || session.country) && (
              <MetaChip
                icon={session.country}
                label={[session.city, session.country].filter(Boolean).join(', ')}
              />
            )}
            {session.os && <MetaChip icon={session.os} label={session.os} />}
            {session.browser && (
              <MetaChip icon={session.browser} label={session.browser} />
            )}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onPrev}
          disabled={!onPrev}
          aria-label="Previous replay"
          title="Previous replay"
        >
          <ChevronUpIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onNext}
          disabled={!onNext}
          aria-label="Next replay"
          title="Next replay"
        >
          <ChevronDownIcon className="size-4" />
        </Button>
        <ReplayShareMenu sessionId={session.id} />
        {/* Styled link, not <Button asChild>: this Button always renders extra
         * spinner/icon children, which breaks Radix Slot's single-child rule. */}
        <ProjectLink
          href={`/sessions/${session.id}`}
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'sm' }),
            'h-8 gap-1.5',
          )}
        >
          <ExternalLinkIcon className="size-3.5" />
          Session
        </ProjectLink>
      </div>
    </div>
  );
}

const PROPERTY_LABELS: Record<string, string> = {
  name: 'Name',
  email: 'Email',
  profileId: 'Profile ID',
  deviceId: 'Device ID',
  country: 'Country',
  region: 'Region',
  city: 'City',
  os: 'OS',
  os_version: 'OS version',
  browser: 'Browser',
  browser_version: 'Browser version',
  device: 'Device',
  brand: 'Brand',
  model: 'Model',
  referrer: 'Referrer',
  referrerName: 'Referrer',
  referrer_name: 'Referrer',
  referrer_type: 'Referrer type',
  entryPath: 'Entry page',
  exitPath: 'Exit page',
  path: 'Last page',
  longitude: 'Longitude',
  latitude: 'Latitude',
};

/** "first_seen_at" / "firstSeenAt" → "First seen at" when no explicit label. */
function propertyLabel(key: string) {
  if (PROPERTY_LABELS[key]) return PROPERTY_LABELS[key];
  const words = key
    .replace(/^\$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type PropertyRow = { key: string; value: string; icon?: boolean };

/**
 * Compact key/value list for the narrow side panel: fixed key column, value
 * wraps (paths, ids) instead of overlapping the key. Click a value to copy.
 */
function PropertyList({ rows }: { rows: PropertyRow[] }) {
  if (rows.length === 0) {
    return <p className="px-1 text-xs text-muted-foreground">Nothing recorded.</p>;
  }
  return (
    <dl className="divide-y rounded-md border bg-card">
      {rows.map((r) => (
        <div
          key={r.key}
          className="grid grid-cols-[104px_minmax(0,1fr)] items-start gap-3 px-3 py-2 text-xs"
        >
          <dt className="pt-px text-muted-foreground">{propertyLabel(r.key)}</dt>
          <dd className="m-0 min-w-0">
            <button
              type="button"
              onClick={() => clipboard(r.value, null)}
              title="Click to copy"
              className="inline-flex max-w-full items-start gap-1.5 text-left font-medium text-foreground [overflow-wrap:anywhere] hover:text-primary"
            >
              {r.icon && (
                <span className="mt-px inline-flex shrink-0 [&_img]:size-3.5 [&_svg]:size-3.5">
                  <SerieIcon name={r.value} />
                </span>
              )}
              <span>{r.value}</span>
            </button>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function PanelSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

const ICON_KEYS = new Set(['country', 'os', 'browser', 'device']);

/** Side panel "User" tab: the person and the session context. */
function ReplayUserPanel({ session }: { session: ReplaySession | undefined }) {
  if (!session) return null;
  const p = session.profile;
  const toRows = (entries: [string, unknown][]): PropertyRow[] =>
    entries
      .filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object')
      .map(([key, v]) => ({ key, value: String(v), icon: ICON_KEYS.has(key) }));

  const userRows = toRows([
    ['name', p ? getProfileName(p) : ''],
    ['email', p?.email],
    ['profileId', session.profileId],
    ['deviceId', session.deviceId],
  ]);
  const sessionRows = toRows([
    ['country', session.country],
    ['city', session.city],
    ['os', session.os],
    ['browser', session.browser],
    ['device', session.device],
    ['referrerName', session.referrerName || session.referrer],
    ['entryPath', session.entryPath],
    ['exitPath', session.exitPath],
  ]);
  const propertyRows = toRows(Object.entries(p?.properties ?? {})).slice(0, 40);

  return (
    <div className="flex flex-col gap-5 p-3">
      <PanelSection title="User">
        <PropertyList rows={userRows} />
        <ProjectLink
          href={`/profiles/${session.profileId}`}
          className="px-1 text-xs font-medium text-primary hover:underline"
        >
          View full profile →
        </ProjectLink>
      </PanelSection>
      <PanelSection title="This session">
        <PropertyList rows={sessionRows} />
      </PanelSection>
      {propertyRows.length > 0 && (
        <PanelSection title="Profile properties">
          <PropertyList rows={propertyRows} />
        </PanelSection>
      )}
    </div>
  );
}

/**
 * Mixpanel-style Session Replays: a searchable list of recorded sessions on the
 * left; the selected replay on the right with a session header, the player on
 * a dark stage, a transport bar, and an Activity / User side panel.
 */
export function SessionReplaysView({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const { search, debouncedSearch, setSearch } = useSearchQueryState();
  const [selectedSessionId, setSelectedSessionId] = useQueryState(
    'session',
    parseAsString,
  );
  // Reuse the chart/events filter model (URL state): event name(s) + property
  // filters. Passed to session.list as an events subquery ("sessions who did …").
  const [replayEventFilters] = useEventQueryFilters();
  const [replayEventNames] = useEventQueryNamesFilter();
  // Window · sort · minimum length · session-property filters (URL state).
  const listState = useReplayListState();
  // Shared-link position: which tab, and the display time in seconds.
  const [linkedTab, setLinkedTab] = useQueryState('tab', parseAsString);
  const [linkedTime, setLinkedTime] = useQueryState('t', parseAsInteger);
  // Absolute moment to open at (epoch ms) — e.g. a funnel step from the
  // funnel "View replays" drill-down. Wins over `t` when both are set.
  const [linkedAt, setLinkedAt] = useQueryState('at', parseAsInteger);
  const activeFilterCount =
    replayEventNames.length +
    replayEventFilters.length +
    listState.sessionFilters.length;
  const [showFilters, setShowFilters] = useState(activeFilterCount > 0);
  // Picking another replay drops the shared position so it isn't re-applied.
  const selectSession = (id: string) => {
    void setLinkedTab(null);
    void setLinkedTime(null);
    void setLinkedAt(null);
    void setSelectedSessionId(id);
  };

  const listQuery = useInfiniteQuery(
    trpc.session.list.infiniteQueryOptions(
      {
        projectId,
        take: 30,
        onlyReplays: true,
        search: debouncedSearch || undefined,
        replayEventNames,
        replayEventFilters,
        ...listState.queryInput,
      },
      {
        getNextPageParam: (lastPage) => lastPage.meta.next,
      },
    ),
  );

  const countQuery = useQuery(
    trpc.session.replayCount.queryOptions({
      projectId,
      search: debouncedSearch || undefined,
      replayEventNames,
      replayEventFilters,
      replayDays: listState.queryInput.replayDays,
      replaySessionFilters: listState.queryInput.replaySessionFilters,
      minReplayDurationMs: listState.queryInput.minReplayDurationMs,
    }),
  );

  // Dedupe by id across pages: a session revived after its server state expired
  // has rows with different created_at, which can straddle a page boundary.
  const sessions = useMemo(() => {
    const seen = new Set<string>();
    return (
      (listQuery.data?.pages.flatMap((p) => p.data) ?? []) as ReplaySession[]
    ).filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
  }, [listQuery.data]);

  // Default the selection to the first replay — but ONLY once, when the list
  // first loads. Re-defaulting whenever `selectedSessionId` clears would fight
  // the router: navigating away (e.g. to /realtime) drops the ?session param,
  // which would re-trigger this effect and immediately revert you back to the
  // replays tab — trapping you on the page. The ref makes it fire at most once.
  const didAutoSelectRef = useRef(false);
  useEffect(() => {
    if (didAutoSelectRef.current) return;
    if (sessions.length === 0) return;
    // Mark "decided" as soon as the list loads — even when we DON'T auto-select
    // (e.g. a deep link already carries ?session=). Otherwise a deep-linked
    // user's ref stays false, and navigating away (which transiently clears
    // ?session=) would re-enter this effect and re-trap them.
    didAutoSelectRef.current = true;
    if (!selectedSessionId) {
      void setSelectedSessionId(sessions[0]!.id);
    }
  }, [sessions, selectedSessionId, setSelectedSessionId]);

  const selectedIndex = sessions.findIndex((s) => s.id === selectedSessionId);
  const listed = selectedIndex >= 0 ? sessions[selectedIndex] : undefined;
  // Deep link to a session that isn't on the loaded pages → fetch it directly.
  const byIdQuery = useQuery({
    ...trpc.session.byId.queryOptions({
      sessionId: selectedSessionId ?? '',
      projectId,
    }),
    enabled: !!selectedSessionId && !listed && !listQuery.isLoading,
  });
  // Like PostHog, the player and header don't depend on the list: a linked
  // replay that isn't on a loaded page fetches its own details. byId only has
  // the event-span duration, so the recording length comes from replaySummary.
  const summaryQuery = useQuery({
    ...trpc.session.replaySummary.queryOptions({
      sessionId: selectedSessionId ?? '',
      projectId,
    }),
    enabled: !!selectedSessionId && !listed && !listQuery.isLoading,
  });
  const linked = byIdQuery.data as ReplaySession | undefined;
  const linkedWithReplay: ReplaySession | undefined = linked
    ? {
        ...linked,
        duration: summaryQuery.data?.durationMs ?? linked.duration,
        replayTabCount: summaryQuery.data?.tabCount,
      }
    : undefined;
  const selected: ReplaySession | undefined = listed ?? linkedWithReplay;

  // A linked replay that IS in the list: scroll its row into view once.
  const scrolledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!listed || scrolledRef.current === listed.id) return;
    scrolledRef.current = listed.id;
    document
      .querySelector(`[data-replay-id="${CSS.escape(listed.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [listed]);

  const goTo = (index: number) => {
    const s = sessions[index];
    if (s) selectSession(s.id);
  };

  const count = countQuery.data ?? sessions.length;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full overflow-hidden bg-background">
        {/* LEFT — replays list */}
        <div className="flex w-[340px] shrink-0 flex-col border-r">
          <div className="flex flex-col gap-2 border-b p-3">
            <div className="flex items-center gap-2">
              <MonitorPlayIcon className="size-4 text-muted-foreground" />
              <span className="font-medium">Replays</span>
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                {count.toLocaleString()} {count === 1 ? 'replay' : 'replays'}
              </span>
            </div>
            <div className="relative">
              <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="replay-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, email or user id"
                className="h-8 pl-8 text-sm"
              />
            </div>
            <ReplayListToolbar state={listState} />
            <button
              type="button"
              onClick={() => setShowFilters((v) => !v)}
              aria-expanded={showFilters}
              className="flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs font-medium hover:bg-muted/50"
            >
              <FilterIcon className="size-3.5 text-muted-foreground" />
              Filters
              {activeFilterCount > 0 && (
                <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground tabular-nums">
                  {activeFilterCount}
                </span>
              )}
              <ChevronDownIcon
                className={cn(
                  'ml-auto size-3.5 text-muted-foreground transition-transform',
                  showFilters && 'rotate-180',
                )}
              />
            </button>
            {showFilters && (
              <div className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto">
                <EventsFilters eventLabel="Sessions who did" />
                <ReplaySessionFiltersCard projectId={projectId} state={listState} />
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {listQuery.isLoading ? (
              <div className="flex h-32 items-center justify-center text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
              </div>
            ) : (
              <>
                {/* Linked replay not on the loaded pages (further down, or
                 * outside the filters/window): pin it so it's visible. */}
                {!listed && linkedWithReplay && (
                  <div className="border-b bg-muted/30">
                    <div className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Opened from link
                    </div>
                    <ReplayListRow
                      session={linkedWithReplay}
                      isActive
                      onSelect={() => {}}
                    />
                  </div>
                )}
                {sessions.length === 0 && (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    No replays match these filters.
                  </div>
                )}
              </>
            )}
            {!listQuery.isLoading &&
              sessions.map((s) => (
                <ReplayListRow
                  key={s.id}
                  session={s}
                  isActive={s.id === selectedSessionId}
                  onSelect={() => selectSession(s.id)}
                />
              ))}

            {listQuery.hasNextPage && (
              <button
                type="button"
                onClick={() => listQuery.fetchNextPage()}
                disabled={listQuery.isFetchingNextPage}
                className="flex w-full items-center justify-center gap-2 py-3 text-xs text-muted-foreground hover:text-foreground"
              >
                {listQuery.isFetchingNextPage && (
                  <Loader2Icon className="size-3 animate-spin" />
                )}
                Load more
              </button>
            )}
          </div>
        </div>

        {/* RIGHT — the replay */}
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedSessionId ? (
            <ReplayShell
              key={selectedSessionId}
              sessionId={selectedSessionId}
              projectId={projectId}
              layout="studio"
              initialWindowId={linkedTab ?? undefined}
              initialTimeSec={linkedTime ?? undefined}
              initialAtMs={linkedAt ?? undefined}
              header={
                <ReplayHeader
                  session={selected}
                  onPrev={selectedIndex > 0 ? () => goTo(selectedIndex - 1) : undefined}
                  onNext={
                    selectedIndex >= 0 && selectedIndex < sessions.length - 1
                      ? () => goTo(selectedIndex + 1)
                      : selectedIndex === -1 && sessions.length > 0
                        ? () => goTo(0) // from a pinned linked replay → top of list
                        : undefined
                  }
                />
              }
              userPanel={<ReplayUserPanel session={selected} />}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a replay to watch
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
