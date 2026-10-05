import { ProjectLink } from '@/components/links';
import { ProfileAvatar } from '@/components/profiles/profile-avatar';
import { SerieIcon } from '@/components/report-chart/common/serie-icon';
import { DropdownMenuShortcut } from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTRPC } from '@/integrations/trpc/react';
import type { IChartData, RouterOutputs } from '@/trpc/client';
import { cn } from '@/utils/cn';
import { formatDateTime } from '@/utils/date';
import { getProfileName } from '@/utils/getters';
import type { IChartInput } from '@openpanel/validation';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { PlayIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { popModal } from '.';
import { ModalHeader } from './Modal/Container';
import { ScrollableModal, useScrollableModal } from './Modal/scrollable-modal';

const ProfileItem = ({ profile }: { profile: any }) => {
  return (
    <ProjectLink
      preload={false}
      href={`/profiles/${profile.id}`}
      title={getProfileName(profile, false)}
      className="col gap-2 rounded-lg border p-2 bg-card"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          return;
        }
        popModal();
      }}
    >
      <div className="row gap-2 items-center">
        <ProfileAvatar {...profile} />
        <div className="flex-1">
          <div className="font-medium">{getProfileName(profile)}</div>
        </div>
      </div>

      <div className="row gap-4 text-sm overflow-hidden">
        {profile.properties.country && (
          <div className="row gap-2 items-center">
            <SerieIcon name={profile.properties.country} />
            <span>
              {profile.properties.country}
              {profile.properties.city && ` / ${profile.properties.city}`}
            </span>
          </div>
        )}
        {profile.properties.os && (
          <div className="row gap-2 items-center">
            <SerieIcon name={profile.properties.os} />
            <span>{profile.properties.os}</span>
          </div>
        )}
        {profile.properties.browser && (
          <div className="row gap-2 items-center">
            <SerieIcon name={profile.properties.browser} />
            <span>{profile.properties.browser}</span>
          </div>
        )}
      </div>
    </ProjectLink>
  );
};
// Shared profile list component
function ProfileList({ profiles }: { profiles: any[] }) {
  const ITEM_HEIGHT = 74;
  const CONTAINER_PADDING = 20;
  const ITEM_GAP = 5;
  const { scrollAreaRef } = useScrollableModal();
  const [isScrollReady, setIsScrollReady] = useState(false);

  // Check if scroll container is ready
  useEffect(() => {
    if (scrollAreaRef.current) {
      setIsScrollReady(true);
    } else {
      setIsScrollReady(false);
    }
  }, [scrollAreaRef]);

  const virtualizer = useVirtualizer({
    count: profiles.length,
    getScrollElement: () => scrollAreaRef.current,
    estimateSize: () => ITEM_HEIGHT + ITEM_GAP,
    overscan: 5,
    paddingStart: CONTAINER_PADDING,
    paddingEnd: CONTAINER_PADDING,
  });

  // Re-measure when scroll container becomes available or profiles change
  useEffect(() => {
    if (isScrollReady && scrollAreaRef.current) {
      // Small delay to ensure DOM is ready
      const timeoutId = setTimeout(() => {
        virtualizer.measure();
      }, 0);
      return () => clearTimeout(timeoutId);
    }
  }, [isScrollReady, profiles.length, virtualizer]);

  if (profiles.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-muted-foreground">No users found</div>
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        width: '100%',
        position: 'relative',
      }}
    >
      {/* Only the visible items in the virtualizer, manually positioned to be in view */}
      {virtualItems.map((virtualItem) => {
        const profile = profiles[virtualItem.index];
        return (
          <div
            key={profile.id}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualItem.size}px`,
              transform: `translateY(${virtualItem.start}px)`,
              padding: `0px ${CONTAINER_PADDING}px ${ITEM_GAP}px`,
            }}
          >
            <ProfileItem profile={profile} />
          </div>
        );
      })}
    </div>
  );
}

// Chart-specific props and component
interface ChartUsersViewProps {
  chartData: IChartData;
  report: IChartInput;
  date: string;
}

function ChartUsersView({ chartData, report, date }: ChartUsersViewProps) {
  const trpc = useTRPC();
  const [selectedSerieId, setSelectedSerieId] = useState<string | null>(
    report.series[0]?.id || null,
  );
  const [selectedBreakdownId, setSelectedBreakdownId] = useState<string | null>(
    null,
  );

  const selectedReportSerie = useMemo(
    () => report.series.find((s) => s.id === selectedSerieId),
    [report.series, selectedSerieId],
  );

  // Get all chart series that match the selected report serie
  const matchingChartSeries = useMemo(() => {
    if (!selectedSerieId || !chartData) return [];
    return chartData.series.filter((s) => s.event.id === selectedSerieId);
  }, [chartData?.series, selectedSerieId]);

  const selectedBreakdown = useMemo(() => {
    if (!selectedBreakdownId) return null;
    return matchingChartSeries.find((s) => s.id === selectedBreakdownId);
  }, [matchingChartSeries, selectedBreakdownId]);

  // Reset breakdown selection when serie changes
  const handleSerieChange = (value: string) => {
    setSelectedSerieId(value);
    setSelectedBreakdownId(null);
  };

  const profilesQuery = useQuery(
    trpc.chart.getProfiles.queryOptions(
      {
        projectId: report.projectId,
        date: date,
        series:
          selectedReportSerie && selectedReportSerie.type === 'event'
            ? [selectedReportSerie]
            : [],
        breakdowns: selectedBreakdown?.event.breakdowns,
        interval: report.interval,
      },
      {
        enabled: !!selectedReportSerie && selectedReportSerie.type === 'event',
      },
    ),
  );

  const profiles = profilesQuery.data ?? [];

  return (
    <ScrollableModal
      header={
        <div>
          <ModalHeader
            title="View Users"
            text={`Users who performed actions on ${new Date(date).toLocaleDateString()}`}
          />
          {report.series.length > 0 && (
            <div className="col md:row gap-2">
              <Select
                value={selectedSerieId || ''}
                onValueChange={handleSerieChange}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Select Serie" />
                </SelectTrigger>
                <SelectContent>
                  {report.series.map((serie) => (
                    <SelectItem key={serie.id} value={serie.id || ''}>
                      {serie.type === 'event'
                        ? serie.displayName || serie.name
                        : serie.displayName || 'Formula'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {matchingChartSeries.length > 1 && (
                <Select
                  value={selectedBreakdownId || ''}
                  onValueChange={(value) => setSelectedBreakdownId(value)}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Select Breakdown" />
                  </SelectTrigger>
                  <SelectContent>
                    {matchingChartSeries
                      .sort((a, b) => b.metrics.sum - a.metrics.sum)
                      .map((serie) => (
                        <SelectItem key={serie.id} value={serie.id}>
                          {Object.values(serie.event.breakdowns ?? {}).join(
                            ', ',
                          )}
                          <DropdownMenuShortcut className="ml-auto">
                            ({serie.data.find((d) => d.date === date)?.count})
                          </DropdownMenuShortcut>
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
          {profiles.length >= 1000 && (
            <p className="mt-2 text-sm text-muted-foreground">
              Showing the first 1,000 users (preview limit).
            </p>
          )}
        </div>
      }
    >
      <div className="col">
        {profilesQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="text-muted-foreground">Loading users...</div>
          </div>
        ) : (
          <ProfileList profiles={profiles} />
        )}
      </div>
    </ScrollableModal>
  );
}

// Funnel-specific props and component
interface FunnelUsersViewProps {
  report: IChartInput;
  stepIndex: number;
  view?: 'users' | 'replays';
  breakdownValues?: string[];
}

function SegmentedButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 text-sm rounded-md transition-colors',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-muted/80',
      )}
    >
      {children}
    </button>
  );
}

function FunnelUsersView({
  report,
  stepIndex,
  view: initialView = 'users',
  breakdownValues,
}: FunnelUsersViewProps) {
  const trpc = useTRPC();
  const [showDropoffs, setShowDropoffs] = useState(false);
  const [view, setView] = useState<'users' | 'replays'>(initialView);

  // The chart's own input + the step / side / breakdown row, so the list is
  // built from the same query as the chart counts.
  const input = {
    ...report,
    stepIndex,
    showDropoffs,
    breakdownValues,
  };

  const profilesQuery = useQuery(
    trpc.chart.getFunnelProfiles.queryOptions(input, {
      enabled: view === 'users',
    }),
  );
  const replaysQuery = useQuery(
    trpc.chart.getFunnelReplays.queryOptions(input, {
      enabled: view === 'replays',
    }),
  );

  const profiles = profilesQuery.data?.profiles ?? [];
  const isLastStep = stepIndex === report.series.length - 1;
  const stepLabel = `step ${stepIndex + 1} of ${report.series.length}`;
  const breakdownLabel = breakdownValues?.length
    ? ` (${breakdownValues.join(' / ')})`
    : '';

  return (
    <ScrollableModal
      header={
        <div className="flex flex-col gap-2">
          <ModalHeader
            title={view === 'users' ? 'View Users' : 'View Replays'}
            text={
              (showDropoffs
                ? `${view === 'users' ? 'Users' : 'Replays of users'} who dropped off after ${stepLabel}`
                : `${view === 'users' ? 'Users' : 'Replays of users'} who completed ${stepLabel} in the funnel`) +
              breakdownLabel
            }
          />
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <SegmentedButton
                active={view === 'users'}
                onClick={() => setView('users')}
              >
                Users
              </SegmentedButton>
              <SegmentedButton
                active={view === 'replays'}
                onClick={() => setView('replays')}
              >
                Replays
              </SegmentedButton>
            </div>
            {!isLastStep && (
              <div className="flex items-center gap-2">
                <SegmentedButton
                  active={!showDropoffs}
                  onClick={() => setShowDropoffs(false)}
                >
                  Completed
                </SegmentedButton>
                <SegmentedButton
                  active={showDropoffs}
                  onClick={() => setShowDropoffs(true)}
                >
                  Dropped Off
                </SegmentedButton>
              </div>
            )}
          </div>
          {view === 'users' && profilesQuery.data && (
            <p className="text-sm text-muted-foreground">
              {profilesQuery.data.total.toLocaleString()}{' '}
              {showDropoffs ? 'dropped off' : 'completed'}
              {profiles.length < profilesQuery.data.totalPeople &&
                ` · ${profiles.length.toLocaleString()} shown (most recent first)`}
            </p>
          )}
          {view === 'replays' && replaysQuery.data && (
            <p className="text-sm text-muted-foreground">
              {replaysQuery.data.totalWithReplay.toLocaleString()} of{' '}
              {replaysQuery.data.totalPeople.toLocaleString()}{' '}
              {showDropoffs ? 'dropped' : 'completed'} users have a replay
              {replaysQuery.data.replays.length <
                replaysQuery.data.totalWithReplay &&
                ` · showing the ${replaysQuery.data.replays.length.toLocaleString()} most recent`}
              . Only recorded (web) sessions have replays.
            </p>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {view === 'users' ? (
          profilesQuery.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-muted-foreground">Loading users...</div>
            </div>
          ) : (
            <ProfileList profiles={profiles} />
          )
        ) : replaysQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="text-muted-foreground">Loading replays...</div>
          </div>
        ) : (
          <FunnelReplayList
            replays={replaysQuery.data?.replays ?? []}
            showDropoffs={showDropoffs}
          />
        )}
      </div>
    </ScrollableModal>
  );
}

type FunnelReplay =
  RouterOutputs['chart']['getFunnelReplays']['replays'][number];

function FunnelReplayList({
  replays,
  showDropoffs,
}: {
  replays: FunnelReplay[];
  showDropoffs: boolean;
}) {
  if (replays.length === 0) {
    return (
      <div className="col items-center gap-1 px-6 py-8 text-center">
        <div className="font-medium">No replays for these users</div>
        <div className="text-sm text-muted-foreground">
          None of their sessions at this step were recorded. Only web sessions
          with session replay enabled are recorded.
        </div>
      </div>
    );
  }

  return (
    <div className="col gap-[5px] p-5">
      {replays.map((replay) => (
        <div
          key={`${replay.profileId}:${replay.sessionId}`}
          className="row items-center gap-3 rounded-lg border bg-card p-2"
        >
          {replay.profile ? (
            <ProfileAvatar {...replay.profile} />
          ) : (
            <ProfileAvatar />
          )}
          <div className="col min-w-0 flex-1">
            <div className="truncate font-medium">
              {replay.profile
                ? getProfileName(replay.profile)
                : replay.profileId}
            </div>
            {replay.stepAt > 0 && (
              <div className="text-sm text-muted-foreground">
                {showDropoffs ? 'Dropped off at step' : 'Reached step'} at{' '}
                {formatDateTime(new Date(replay.stepAt))}
              </div>
            )}
          </div>
          <ProjectLink
            preload={false}
            href="/session-replays"
            search={
              {
                session: replay.sessionId,
                ...(replay.windowId ? { tab: replay.windowId } : {}),
                ...(replay.stepAt > 0 ? { at: replay.stepAt } : {}),
              } as any
            }
            className="row shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey) {
                return;
              }
              popModal();
            }}
          >
            <PlayIcon className="size-3.5" />
            Watch
          </ProjectLink>
        </div>
      ))}
    </div>
  );
}

// Union type for props
type ViewChartUsersProps =
  | {
      type: 'chart';
      chartData: IChartData;
      report: IChartInput;
      date: string;
    }
  | {
      type: 'funnel';
      report: IChartInput;
      stepIndex: number;
      view?: 'users' | 'replays';
      // Values of the clicked breakdown row, in breakdown order.
      breakdownValues?: string[];
    };

// Main component that routes to the appropriate view
export default function ViewChartUsers(props: ViewChartUsersProps) {
  if (props.type === 'funnel') {
    return (
      <FunnelUsersView
        report={props.report}
        stepIndex={props.stepIndex}
        view={props.view}
        breakdownValues={props.breakdownValues}
      />
    );
  }

  return (
    <ChartUsersView
      chartData={props.chartData}
      report={props.report}
      date={props.date}
    />
  );
}
