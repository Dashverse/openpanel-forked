import { ProfileAvatar } from '@/components/profiles/profile-avatar';
import { ReplayShell } from '@/components/sessions/replay';
import { formatDuration } from '@/components/sessions/replay/replay-utils';
import { Input } from '@/components/ui/input';
import { useSearchQueryState } from '@/hooks/use-search-query-state';
import { useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';
import { formatDateTime } from '@/utils/date';
import { getProfileName } from '@/utils/getters';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  Loader2Icon,
  MonitorPlayIcon,
  SearchIcon,
} from 'lucide-react';
import { parseAsString, useQueryState } from 'nuqs';
import { useEffect, useMemo, useRef } from 'react';

/**
 * Mixpanel-style Session Replays browser: a searchable list of sessions that
 * have a recording on the left, and the reused replay player on the right.
 */
export function SessionReplaysView({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const { search, debouncedSearch, setSearch } = useSearchQueryState();
  const [selectedSessionId, setSelectedSessionId] = useQueryState(
    'session',
    parseAsString,
  );

  const listQuery = useInfiniteQuery(
    trpc.session.list.infiniteQueryOptions(
      {
        projectId,
        take: 30,
        onlyReplays: true,
        search: debouncedSearch,
      },
      {
        getNextPageParam: (lastPage) => lastPage.meta.next,
      },
    ),
  );

  const countQuery = useQuery(
    trpc.session.replayCount.queryOptions({
      projectId,
      search: debouncedSearch,
    }),
  );

  const sessions = useMemo(
    () => listQuery.data?.pages.flatMap((p) => p.data) ?? [],
    [listQuery.data],
  );

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
      void setSelectedSessionId(sessions[0].id);
    }
  }, [sessions, selectedSessionId, setSelectedSessionId]);

  const count = countQuery.data ?? sessions.length;

  return (
    <div className="flex h-full overflow-hidden bg-background">
      {/* LEFT — replays list */}
      <div className="flex w-[340px] shrink-0 flex-col border-r">
        <div className="border-b p-3">
          <div className="mb-2 flex items-center gap-2">
            <MonitorPlayIcon className="size-4 text-muted-foreground" />
            <span className="font-medium">Replays</span>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {count} {count === 1 ? 'replay' : 'replays'}
            </span>
          </div>
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search for replays"
              className="h-8 pl-8 text-sm"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {listQuery.isLoading ? (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No replays found.
            </div>
          ) : (
            sessions.map((s) => {
              const isActive = s.id === selectedSessionId;
              const name = getProfileName(s.profile) || s.profileId;
              return (
                <div key={s.id} className="border-b last:border-b-0">
                  <div
                    className={cn(
                      'group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50',
                      isActive && 'bg-primary/5',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        void setSelectedSessionId(s.id);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <ProfileAvatar
                        className="shrink-0"
                        size="sm"
                        avatar={s.profile?.avatar}
                        firstName={s.profile?.firstName}
                        lastName={s.profile?.lastName}
                        email={s.profile?.email}
                        isExternal={s.profile?.isExternal}
                        id={s.profileId}
                      />
                      <div className="min-w-0 flex-1">
                        <div
                          className={cn(
                            'truncate text-sm font-medium leading-5',
                            isActive && 'text-primary',
                          )}
                        >
                          {name}
                        </div>
                        <div className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">
                          {formatDateTime(s.createdAt)} · {s.eventCount} events ·{' '}
                          {formatDuration(s.duration)}
                        </div>
                      </div>
                    </button>
                  </div>
                </div>
              );
            })
          )}

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

      {/* RIGHT — player (fills the pane; window tabs as a right rail) */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-4">
        {selectedSessionId ? (
          <div className="w-full">
            <ReplayShell
              key={selectedSessionId}
              sessionId={selectedSessionId}
              projectId={projectId}
              showEventFeed
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a replay to watch
          </div>
        )}
      </div>
    </div>
  );
}
