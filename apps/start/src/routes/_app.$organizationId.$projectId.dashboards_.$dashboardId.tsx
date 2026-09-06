import {
  DashboardBlock,
  dashboardBlockViews,
  getDashboardBlockSearchText,
} from '@/components/dashboard/dashboard-block';
import { EditDashboardName } from '@/components/dashboard/edit-dashboard-name';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import { useOverviewOptions } from '@/components/overview/useOverviewOptions';
import { ReportChart } from '@/components/report-chart';
import { Button, LinkButton } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/utils/cn';
import { createProjectTitle } from '@/utils/title';
import { DASHBOARD_ROW_HEIGHT, toFineReportLayout } from '@openpanel/common';
import { dashboardBlockKindSchema } from '@openpanel/validation';
import {
  BarChart3Icon,
  ChevronDownIcon,
  CopyIcon,
  LayoutPanelTopIcon,
  MoreHorizontal,
  PlusIcon,
  RefreshCw,
  RotateCcw,
  SearchIcon,
  Trash,
  TrashIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import FullPageLoadingState from '@/components/full-page-loading-state';
import { OverviewInterval } from '@/components/overview/overview-interval';
import { OverviewRange } from '@/components/overview/overview-range';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { openServerCacheBypassWindow } from '@/integrations/trpc/cache-bypass';
import { handleErrorToastOptions, useTRPC } from '@/integrations/trpc/react';
import { showConfirm } from '@/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Responsive, WidthProvider } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const ResponsiveGridLayout = WidthProvider(Responsive);

type Layout = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
};

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/dashboards_/$dashboardId',
)({
  component: Component,
  head: () => {
    return {
      meta: [
        {
          title: createProjectTitle('Dashboard'),
        },
      ],
    };
  },
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.prefetchQuery(
        context.trpc.dashboard.byId.queryOptions({
          id: params.dashboardId,
          projectId: params.projectId,
        }),
      ),
      context.queryClient.prefetchQuery(
        context.trpc.report.list.queryOptions({
          dashboardId: params.dashboardId,
          projectId: params.projectId,
        }),
      ),
      context.queryClient.prefetchQuery(
        context.trpc.project.getProjectWithClients.queryOptions({
          projectId: params.projectId,
        }),
      ),
      context.queryClient.prefetchQuery(
        context.trpc.organization.get.queryOptions({
          organizationId: params.organizationId,
        }),
      ),
    ]);
  },
  pendingComponent: FullPageLoadingState,
});

// Report Skeleton Component
function ReportSkeleton() {
  return (
    <div className="card h-full flex flex-col animate-pulse">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="flex-1">
          <div className="h-5 w-32 bg-muted rounded mb-2" />
          <div className="h-4 w-24 bg-muted/50 rounded" />
        </div>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-muted rounded" />
          <div className="w-8 h-8 bg-muted rounded" />
        </div>
      </div>
      <div className="p-4 flex-1 flex items-center justify-center aspect-video" />
    </div>
  );
}

// Report Item Component
function ReportItem({
  report,
  organizationId,
  projectId,
  range,
  startDate,
  endDate,
  interval,
  reloadKey,
  onDelete,
  onDuplicate,
}: {
  report: any;
  organizationId: string;
  projectId: string;
  range: any;
  startDate: any;
  endDate: any;
  interval: any;
  reloadKey: number;
  onDelete: (reportId: string) => void;
  onDuplicate: (reportId: string) => void;
}) {
  const router = useRouter();

  return (
    <div className="card h-full flex flex-col">
      <div className="flex items-center hover:bg-muted/50 justify-between border-b border-border px-3 py-1.5 leading-none [&_svg]:hover:opacity-100">
        <div
          className="flex-1 min-w-0 cursor-pointer -mx-3 -my-1.5 px-3 py-1.5"
          onClick={(event) => {
            if (event.metaKey) {
              window.open(
                `/${organizationId}/${projectId}/reports/${report.id}`,
                '_blank',
              );
              return;
            }
            router.navigate({
              from: Route.fullPath,
              to: '/$organizationId/$projectId/reports/$reportId',
              params: {
                reportId: report.id,
              },
            });
          }}
          onKeyUp={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              router.navigate({
                from: Route.fullPath,
                to: '/$organizationId/$projectId/reports/$reportId',
                params: {
                  reportId: report.id,
                },
              });
            }
          }}
          role="button"
          tabIndex={0}
        >
          <div className="font-medium text-sm truncate">{report.name}</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="drag-handle cursor-move p-1 hover:bg-muted rounded">
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="opacity-30 hover:opacity-100"
            >
              <circle cx="4" cy="4" r="1.5" />
              <circle cx="4" cy="8" r="1.5" />
              <circle cx="4" cy="12" r="1.5" />
              <circle cx="12" cy="4" r="1.5" />
              <circle cx="12" cy="8" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
            </svg>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger className="flex h-7 w-7 items-center justify-center rounded hover:border">
              <MoreHorizontal size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[200px]">
              <DropdownMenuItem
                onClick={(event) => {
                  event.stopPropagation();
                  onDuplicate(report.id);
                }}
              >
                <CopyIcon size={16} className="mr-2" />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuGroup>
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(report.id);
                  }}
                >
                  <Trash size={16} className="mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div
        className={cn(
          'p-4 overflow-auto flex-1',
          report.chartType === 'metric' && 'p-0',
        )}
      >
        <ReportChart
          key={reloadKey}
          options={
            ['linear', 'conversion', 'funnel'].includes(report.chartType)
              ? { fillHeight: true }
              : {}
          }
          report={
            {
              ...report,
              range: range ?? report.range,
              startDate: startDate ?? null,
              endDate: endDate ?? null,
              interval: interval ?? report.interval,
            } as any
          }
        />
      </div>
    </div>
  );
}

function Component() {
  const router = useRouter();
  const { organizationId, dashboardId, projectId } = Route.useParams();
  const trpc = useTRPC();
  const { range, startDate, endDate, interval } = useOverviewOptions();

  const dashboardQuery = useQuery(
    trpc.dashboard.byId.queryOptions({
      id: dashboardId,
      projectId,
    }),
  );

  const reportsQuery = useQuery(
    trpc.report.list.queryOptions({
      dashboardId,
      projectId,
    }),
  );

  const blocksQuery = useQuery(
    trpc.dashboard.listBlocks.queryOptions(
      { dashboardId },
      { refetchOnMount: 'always' },
    ),
  );
  const layoutQuery = useQuery(
    trpc.dashboard.getLayout.queryOptions(
      { dashboardId },
      { refetchOnMount: 'always' },
    ),
  );

  const queryClient = useQueryClient();
  // Bumped on Reload to remount every ReportChart, which resets the latched
  // lazy-loading state (`once.current`). That way Reload behaves like a fresh
  // page load: only in-viewport charts refetch, the rest reload lazily on
  // scroll — instead of refiring every previously-seen chart at once.
  const [reloadKey, setReloadKey] = useState(0);

  // tRPC's React Query keys are shaped `[[router, procedure], { input, type }]`,
  // so chart procedures match `queryKey[0][0] === 'chart'`. The "Updated"
  // indicator pairs this with `type: 'active'` to consider only charts mounted
  // on the CURRENT dashboard (others visited this session are inactive); we
  // can't scope by `input.dashboardId` since funnel inputs don't carry one.
  // Reload's removeQueries deliberately does NOT filter by active (see below).
  const isChartQuery = (query: { queryKey: unknown }) =>
    (query.queryKey as [string[]] | undefined)?.[0]?.[0] === 'chart';

  // Charts read from a server-side Redis cache, so the dashboard loads fast and
  // stops fanning out to ClickHouse on every visit. Reload opens a cache bypass
  // window (server recomputes fresh + repopulates) and remounts charts.
  const handleReload = useCallback(() => {
    openServerCacheBypassWindow();
    setReloadKey((k) => k + 1);
  }, []);

  // After the remount commits, drop cached chart data so the remounted charts
  // refetch (carrying the cache-bypass header → fresh from ClickHouse + cache
  // repopulate). This MUST be unconditional (no `type: 'active'` filter): right
  // after the remount the charts are still lazy/disabled (intersection fires a
  // frame later), so they aren't "active" yet — filtering on active would leave
  // their data in place and Reload would just re-show the cached value. Removing
  // all chart queries is harmless: other dashboards simply refetch (from the
  // server cache) when revisited.
  useEffect(() => {
    if (reloadKey === 0) return;
    queryClient.removeQueries({ predicate: isChartQuery });
  }, [reloadKey, queryClient]);

  // "Last updated" = when THIS dashboard's chart data was actually computed from
  // ClickHouse (the server stamps `__computedAt` into the payload, so it survives
  // caching). This is the TRUE data freshness — a cache hit reports the original
  // compute time, not when this browser read it. Scoped to the current dashboard
  // and shown as the oldest across its charts ("nothing newer than").
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  useEffect(() => {
    // Reset when switching dashboards so we don't briefly show the prior
    // dashboard's timestamp.
    setLastUpdatedAt(null);
    const cache = queryClient.getQueryCache();
    const sync = () => {
      const stamps = cache
        .findAll({ type: 'active', predicate: isChartQuery })
        .map(
          (query) =>
            (query.state.data as { __computedAt?: number })?.__computedAt,
        )
        .filter((ts): ts is number => typeof ts === 'number');
      if (stamps.length > 0) {
        setLastUpdatedAt(Math.min(...stamps));
      }
    };
    sync();
    return cache.subscribe(sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, dashboardId]);

  const dashboardDeletion = useMutation(
    trpc.dashboard.delete.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        toast('Dashboard deleted');
        router.navigate({
          to: '/$organizationId/$projectId/dashboards',
          params: {
            organizationId,
            projectId,
          },
        });
      },
    }),
  );

  const [searchQuery, setSearchQuery] = useState('');
  const allReports = reportsQuery.data ?? [];
  const allBlocks = blocksQuery.data ?? [];
  const search = searchQuery.trim().toLowerCase();
  const reports = allReports.filter((report) =>
    report.name.toLowerCase().includes(search),
  );
  const blocks = allBlocks.filter((block) =>
    getDashboardBlockSearchText(block).toLowerCase().includes(search),
  );
  const itemCount = reports.length + blocks.length;
  const dashboard = dashboardQuery.data;
  const [isGridReady, setIsGridReady] = useState(false);
  const [enableTransitions, setEnableTransitions] = useState(false);

  useEffect(() => {
    if (itemCount > 0 && !isGridReady) {
      const timer = setTimeout(() => setIsGridReady(true), 0);
      return () => clearTimeout(timer);
    }
  }, [itemCount, isGridReady]);
  useEffect(() => {
    if (!isGridReady) return;
    const timer = setTimeout(() => setEnableTransitions(true), 100);
    return () => clearTimeout(timer);
  }, [isGridReady]);

  const refreshGrid = () =>
    Promise.all([
      queryClient.invalidateQueries(
        trpc.dashboard.listBlocks.queryFilter({ dashboardId }),
      ),
      queryClient.invalidateQueries(
        trpc.dashboard.getLayout.queryFilter({ dashboardId }),
      ),
    ]);
  const createBlock = useMutation(
    trpc.dashboard.createBlock.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess: () => {
        setSearchQuery('');
        return refreshGrid();
      },
    }),
  );
  const updateBlock = useMutation(
    trpc.dashboard.updateBlock.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess: refreshGrid,
    }),
  );
  const duplicateBlock = useMutation(
    trpc.dashboard.duplicateBlock.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess: refreshGrid,
    }),
  );
  const deleteBlock = useMutation(
    trpc.dashboard.deleteBlock.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess: refreshGrid,
    }),
  );

  const reportDeletion = useMutation(
    trpc.report.delete.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        reportsQuery.refetch();
        refreshGrid();
        toast('Report deleted');
      },
    }),
  );

  const reportDuplicate = useMutation(
    trpc.report.duplicate.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        reportsQuery.refetch();
        refreshGrid();
        toast('Report duplicated');
      },
    }),
  );

  const updateLayout = useMutation(
    trpc.dashboard.saveLayout.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess: refreshGrid,
    }),
  );
  const resetLayout = useMutation(
    trpc.dashboard.resetGridLayout.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        toast('Layout reset to default');
        return refreshGrid();
      },
    }),
  );
  const layouts = useMemo(() => {
    const saved = new Map(
      (layoutQuery.data ?? []).map((item) => [item.id, item]),
    );
    const baseLayout = [
      ...(reportsQuery.data ?? []).map(
        (report, index) =>
          saved.get(report.id) ??
          toFineReportLayout(report.id, report.layout, index),
      ),
      ...(blocksQuery.data ?? []).map(
        (block) =>
          saved.get(block.id) ?? {
            id: block.id,
            kind: 'block' as const,
            x: block.x,
            y: block.y,
            w: block.w,
            h: block.h,
            minW: block.minW,
            minH: block.minH,
          },
      ),
    ].map((item) => ({ ...item, i: item.id }));
    return {
      lg: baseLayout,
      md: baseLayout,
      sm: baseLayout.map((item) => ({
        ...item,
        w: Math.min(item.w, 6),
        x: Math.min(item.x, 6 - Math.min(item.w, 6)),
      })),
      xs: baseLayout.map((item) => ({ ...item, w: 4, x: 0 })),
      xxs: baseLayout.map((item) => ({ ...item, w: 2, x: 0 })),
    };
  }, [layoutQuery.data, reportsQuery.data, blocksQuery.data]);
  const [breakpoint, setBreakpoint] = useState('lg');
  const saveLayout = (newLayout: Layout[]) => {
    if (search || updateLayout.isPending) return;
    const original = new Map(layouts.lg.map((item) => [item.id, item]));
    const items = newLayout.flatMap((item) => {
      const previous = original.get(item.i);
      if (!previous) return [];
      const next = {
        ...previous,
        x: breakpoint === 'lg' || breakpoint === 'md' ? item.x : previous.x,
        w: breakpoint === 'lg' || breakpoint === 'md' ? item.w : previous.w,
        y: item.y,
        h: item.h,
      };
      if (
        next.x === previous.x &&
        next.y === previous.y &&
        next.w === previous.w &&
        next.h === previous.h
      )
        return [];
      return [next];
    });
    if (items.length > 0) updateLayout.mutate({ dashboardId, items });
  };

  if (!dashboard) {
    return null; // Loading handled by suspense
  }

  return (
    <PageContainer fluid>
      <PageHeader
        title={
          <EditDashboardName
            key={dashboard.id}
            id={dashboard.id}
            name={dashboard.name}
            projectId={projectId}
          />
        }
        className="mb-3"
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button icon={PlusIcon}>
                  Add
                  <ChevronDownIcon className="ml-0.5 size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem asChild>
                  <Link
                    from={Route.fullPath}
                    to="/$organizationId/$projectId/reports"
                  >
                    <BarChart3Icon className="mr-2 size-4" /> Report
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {dashboardBlockKindSchema.options.map((kind) => {
                  const { label, icon: Icon } = dashboardBlockViews[kind];
                  return (
                    <DropdownMenuItem
                      key={kind}
                      disabled={createBlock.isPending}
                      onClick={() => createBlock.mutate({ dashboardId, kind })}
                    >
                      <Icon className="mr-2 size-4" /> {label}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[200px]">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    onClick={() =>
                      showConfirm({
                        title: 'Reset layout',
                        text: 'Are you sure you want to reset the layout to default? This will clear all custom positioning and sizing.',
                        onConfirm: () => resetLayout.mutate({ dashboardId }),
                      })
                    }
                  >
                    <RotateCcw className="mr-2 size-4" />
                    Reset layout
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() =>
                      showConfirm({
                        title: 'Delete dashboard',
                        text: 'Are you sure you want to delete this dashboard? All reports, text blocks, and dividers will be deleted!',
                        onConfirm: () =>
                          dashboardDeletion.mutate({ id: dashboardId }),
                      })
                    }
                  >
                    <TrashIcon className="mr-2 size-4" />
                    Delete dashboard
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <div className="row mb-4 flex-wrap items-center gap-2">
        {allReports.length > 0 && (
          <>
            <OverviewRange />
            <OverviewInterval />
          </>
        )}
        <div className="row ml-auto gap-2">
          <div className="relative flex items-center">
            <SearchIcon className="absolute left-2.5 size-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search dashboard..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-48"
              style={{ paddingLeft: '2rem' }}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={RefreshCw}
            onClick={handleReload}
            title={
              lastUpdatedAt
                ? `Data last updated ${new Date(lastUpdatedAt).toLocaleString()} — click to reload`
                : 'Reload reports with fresh data'
            }
            className="text-muted-foreground"
          >
            <span className="max-md:hidden">
              {lastUpdatedAt
                ? new Date(lastUpdatedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : 'Reload'}
            </span>
          </Button>
        </div>
      </div>

      {reportsQuery.isError || blocksQuery.isError || layoutQuery.isError ? (
        <FullPageEmptyState
          title="Could not load dashboard"
          icon={LayoutPanelTopIcon}
        >
          <Button
            onClick={() => {
              reportsQuery.refetch();
              refreshGrid();
            }}
          >
            Try again
          </Button>
        </FullPageEmptyState>
      ) : reportsQuery.isLoading ||
        blocksQuery.isLoading ||
        layoutQuery.isLoading ? (
        <FullPageLoadingState />
      ) : allReports.length + allBlocks.length === 0 ? (
        <FullPageEmptyState title="Empty dashboard" icon={LayoutPanelTopIcon}>
          <p>Add a report, text, or divider to build your dashboard.</p>
          <LinkButton
            from={Route.fullPath}
            to={'/$organizationId/$projectId/reports'}
            className="mt-14"
            icon={PlusIcon}
          >
            Create report
          </LinkButton>
        </FullPageEmptyState>
      ) : itemCount === 0 ? (
        <FullPageEmptyState title="No items found" icon={SearchIcon}>
          <p>No items match "{searchQuery}"</p>
        </FullPageEmptyState>
      ) : !isGridReady || reportsQuery.isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <ReportSkeleton />
          <ReportSkeleton />
          <ReportSkeleton />
          <ReportSkeleton />
          <ReportSkeleton />
          <ReportSkeleton />
        </div>
      ) : (
        <div className="-mx-4">
          <style>{`
            .react-grid-item {
              transition: ${enableTransitions ? 'transform 200ms ease, width 200ms ease, height 200ms ease' : 'none'} !important;
            }
            .react-grid-item.react-grid-placeholder {
              background: none !important;
              opacity: 0.5;
              transition-duration: 100ms;
              border-radius: 0.5rem;
              border: 1px dashed var(--primary);
            }
            .react-grid-item.resizing {
              transition: none !important;
            }
            .react-grid-item:has([data-editing="true"]) {
              z-index: 20;
            }
          `}</style>
          <ResponsiveGridLayout
            key={`${dashboardId}:${search ? 'search' : 'all'}`}
            className="layout"
            layouts={layouts}
            breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
            cols={{ lg: 12, md: 12, sm: 6, xs: 4, xxs: 2 }}
            rowHeight={DASHBOARD_ROW_HEIGHT}
            onDragStop={saveLayout}
            onResizeStop={saveLayout}
            onBreakpointChange={setBreakpoint}
            draggableHandle=".drag-handle"
            compactType="vertical"
            preventCollision={false}
            isDraggable={!search && !updateLayout.isPending}
            isResizable={!search && !updateLayout.isPending}
            margin={[16, 16]}
            transformScale={1}
            useCSSTransforms={true}
          >
            {reports.map((report) => (
              <div key={report.id}>
                <ReportItem
                  report={report}
                  organizationId={organizationId}
                  projectId={projectId}
                  range={range}
                  startDate={startDate}
                  endDate={endDate}
                  interval={interval}
                  reloadKey={reloadKey}
                  onDelete={(reportId) => {
                    reportDeletion.mutate({ reportId });
                  }}
                  onDuplicate={(reportId) => {
                    reportDuplicate.mutate({ reportId });
                  }}
                />
              </div>
            ))}
            {blocks.map((block) => (
              <div key={block.id}>
                <DashboardBlock
                  block={block}
                  onSave={(values) =>
                    updateBlock.mutateAsync({ id: block.id, ...values })
                  }
                  onDuplicate={() => duplicateBlock.mutate({ id: block.id })}
                  onDelete={() => deleteBlock.mutate({ id: block.id })}
                />
              </div>
            ))}
          </ResponsiveGridLayout>
        </div>
      )}
    </PageContainer>
  );
}
