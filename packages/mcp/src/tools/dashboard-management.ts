import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type Prisma,
  type Report,
  db,
  getDashboardById,
  getId,
  getProjectById,
} from '@openpanel/db';
import { zReport } from '@openpanel/validation';
import { z } from 'zod';
import type { McpAuthContext } from '../auth';
import {
  projectIdSchema,
  resolveProjectId,
  table,
  withErrorHandling,
  zLimit,
} from './shared';

/**
 * Strict, persistable report configuration.
 *
 * Built from `zReport` (the same schema the dashboard saves), minus the fields
 * that never belong in a saved-report body: `projectId` is derived from the
 * dashboard, and `limit`/`offset` are query-time paging concerns. `.strict()`
 * rejects unknown keys so a caller can't smuggle stray fields into the row.
 */
const reportSchema = zReport
  .omit({ projectId: true, limit: true, offset: true })
  .strict()
  .superRefine((report, ctx) => {
    if (report.range !== 'custom') {
      return;
    }

    const dates = [
      ['startDate', report.startDate],
      ['endDate', report.endDate],
    ] as const;

    for (const [field, value] of dates) {
      if (!isValidDateOnly(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is required in YYYY-MM-DD format for custom ranges`,
        });
      }
    }

    if (
      isValidDateOnly(report.startDate) &&
      isValidDateOnly(report.endDate) &&
      report.startDate! > report.endDate!
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'endDate must be on or after startDate',
      });
    }
  });

const layoutSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
    minW: z.number().int().positive().optional(),
    minH: z.number().int().positive().optional(),
    maxW: z.number().int().positive().optional(),
    maxH: z.number().int().positive().optional(),
  })
  .superRefine((layout, ctx) => {
    if (
      layout.minW !== undefined &&
      layout.maxW !== undefined &&
      layout.maxW < layout.minW
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxW'],
        message: 'maxW must be greater than or equal to minW',
      });
    }
    if (layout.minW !== undefined && layout.minW > layout.w) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minW'],
        message: 'minW must be less than or equal to w',
      });
    }
    if (layout.maxW !== undefined && layout.maxW < layout.w) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxW'],
        message: 'maxW must be greater than or equal to w',
      });
    }
    if (
      layout.minH !== undefined &&
      layout.maxH !== undefined &&
      layout.maxH < layout.minH
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxH'],
        message: 'maxH must be greater than or equal to minH',
      });
    }
    if (layout.minH !== undefined && layout.minH > layout.h) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minH'],
        message: 'minH must be less than or equal to h',
      });
    }
    if (layout.maxH !== undefined && layout.maxH < layout.h) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxH'],
        message: 'maxH must be greater than or equal to h',
      });
    }
  });

function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

/**
 * Base URL for dashboard deep-links. Mirrors the pattern used for replay links
 * in packages/db mcp-cores; the fork has no dedicated dashboard-links module.
 */
function dashboardBaseUrl() {
  return (
    process.env.DASHBOARD_URL || process.env.NEXT_PUBLIC_DASHBOARD_URL || ''
  );
}

function dashboardUrl(
  organizationId: string,
  projectId: string,
  dashboardId: string,
) {
  return `${dashboardBaseUrl()}/${organizationId}/${projectId}/dashboards/${dashboardId}`;
}

function reportUrl(
  organizationId: string,
  projectId: string,
  reportId: string,
) {
  return `${dashboardBaseUrl()}/${organizationId}/${projectId}/reports/${reportId}`;
}

/**
 * Map a validated report config onto the fork's `reports` columns.
 *
 * This mirrors the dashboard save path (packages/trpc report router
 * create/update) field-for-field so a report saved through MCP is byte-for-byte
 * what the dashboard would have written — no setting is silently dropped. Every
 * persisted column below has a matching `reports` column in the Prisma schema.
 *
 * Fork divergence from upstream: our Report model has `hiddenSeries` (there is
 * no `visibleSeries`/`options` column), so `series` → `events` and the visible
 * set is persisted as `hiddenSeries`. Custom dates are only kept for the
 * `custom` range and cleared otherwise, so a full replacement can't leave a
 * stale window behind.
 *
 * `cohortFilters` is intentionally absent: it has no `reports` column and the
 * dashboard save path doesn't persist it either — it's a chart-time-only input.
 */
function reportData(report: z.infer<typeof reportSchema>) {
  return {
    name: report.name,
    events: report.series,
    globalFilters: report.globalFilters ?? [],
    interval: report.interval,
    breakdowns: report.breakdowns,
    chartType: report.chartType,
    lineType: report.lineType,
    comparison: report.comparison ?? 'none',
    range: report.range,
    formula: report.formula ?? null,
    previous: report.previous ?? false,
    unit: report.unit ?? null,
    // 'count' is a chart-time metric; the reports table only stores the four
    // Prisma Metric values, so collapse it to 'sum' exactly as the report
    // router does.
    metric: report.metric === 'count' ? 'sum' : report.metric,
    hiddenSeries: report.hiddenSeries ?? [],
    // Funnel-specific settings (window + grouping key) and the Hold Property
    // Constant list — dedicated columns, previously dropped by this mapping.
    criteria: report.criteria ?? null,
    funnelGroup: report.funnelGroup ?? null,
    funnelWindow: report.funnelWindow ?? null,
    holdProperties: report.holdProperties ?? [],
    // Conversion/measurement settings.
    measuring: report.measuring ?? null,
    sortOrder: report.sortOrder ?? 'desc',
    ttcAggregation: report.ttcAggregation ?? 'avg',
    startDate: report.range === 'custom' ? report.startDate : null,
    endDate: report.range === 'custom' ? report.endDate : null,
  };
}

async function requireDashboard(projectId: string, dashboardId: string) {
  const dashboard = await getDashboardById(dashboardId, projectId);
  if (!dashboard) {
    throw new Error('Dashboard not found');
  }
  return dashboard;
}

async function requireReport(projectId: string, reportId: string) {
  // Ownership check for a mutation, so read it from the primary to avoid a
  // replica-lag "Report not found" right after another write.
  const report = await db.$primary().report.findFirst({
    where: { id: reportId, projectId },
  });
  if (!report) {
    throw new Error('Report not found');
  }
  return report;
}

function withDashboardUrl(
  organizationId: string,
  projectId: string,
  dashboard: {
    id: string;
    name: string;
    projectId: string;
    organizationId: string;
    createdAt: Date;
    updatedAt: Date;
  },
) {
  // Explicit fields: getDashboardById includes the full project row, which is
  // more than this tool should hand back.
  return {
    id: dashboard.id,
    name: dashboard.name,
    projectId: dashboard.projectId,
    organizationId: dashboard.organizationId,
    createdAt: dashboard.createdAt,
    updatedAt: dashboard.updatedAt,
    dashboard_url: dashboardUrl(organizationId, projectId, dashboard.id),
  };
}

function withReportUrl(
  organizationId: string,
  projectId: string,
  report: { id: string },
) {
  return {
    ...report,
    // Keep the existing MCP report-tool field name for this report URL.
    dashboard_url: reportUrl(organizationId, projectId, report.id),
  };
}

function canonicalReportConfig(report: {
  name: string;
  events: unknown;
  globalFilters: unknown;
  interval: string;
  breakdowns: unknown;
  chartType: string;
  lineType: string;
  comparison: string | null;
  range: string;
  formula: string | null;
  previous: boolean;
  unit: string | null;
  metric: string;
  hiddenSeries: unknown;
  criteria: string | null;
  funnelGroup: string | null;
  funnelWindow: number | null;
  holdProperties: unknown;
  measuring: string | null;
  sortOrder: string | null;
  ttcAggregation: string | null;
  startDate: string | null;
  endDate: string | null;
}) {
  return {
    name: report.name,
    series: report.events,
    globalFilters: report.globalFilters,
    interval: report.interval,
    breakdowns: report.breakdowns,
    chartType: report.chartType,
    lineType: report.lineType,
    comparison: report.comparison ?? undefined,
    range: report.range,
    startDate: report.startDate,
    endDate: report.endDate,
    previous: report.previous,
    formula: report.formula ?? undefined,
    metric: report.metric,
    unit: report.unit ?? undefined,
    hiddenSeries: report.hiddenSeries,
    // Funnel / conversion settings — surfaced so a get_dashboard → update_report
    // round trip preserves them instead of resetting to defaults.
    criteria: report.criteria ?? undefined,
    funnelGroup: report.funnelGroup ?? undefined,
    funnelWindow: report.funnelWindow ?? undefined,
    holdProperties: report.holdProperties,
    measuring: report.measuring ?? undefined,
    sortOrder: report.sortOrder ?? undefined,
    ttcAggregation: report.ttcAggregation ?? undefined,
  };
}

export function registerDashboardManagementTools(
  server: McpServer,
  context: McpAuthContext,
) {
  server.tool(
    'get_dashboard',
    'Get a dashboard, all of its reports, and their saved layouts.',
    {
      projectId: projectIdSchema(context),
      dashboardId: z.string().describe('The dashboard ID to retrieve'),
    },
    async ({ projectId: inputProjectId, dashboardId }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const dashboard = await requireDashboard(projectId, dashboardId);
        const reports = await db.report.findMany({
          where: { dashboardId, projectId },
          include: { layout: true },
        });
        const reportsWithUrls = reports.map((report) => ({
          id: report.id,
          report: canonicalReportConfig(report),
          layout: report.layout,
          dashboard_url: reportUrl(
            context.organizationId,
            projectId,
            report.id,
          ),
        }));

        return {
          dashboard: withDashboardUrl(
            context.organizationId,
            projectId,
            dashboard,
          ),
          reports: reportsWithUrls,
          layouts: reportsWithUrls.flatMap((report) =>
            report.layout ? [report.layout] : [],
          ),
        };
      }),
  );

  server.tool(
    'list_dashboards',
    'List the dashboards in the resolved project (id, name, timestamps, report count, deep-link). Read-only. Call this to discover which dashboards exist and pick a dashboardId before saving a report with create_report.',
    {
      projectId: projectIdSchema(context),
      limit: zLimit(50, 200),
    },
    async ({ projectId: inputProjectId, limit }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const dashboards = await db.dashboard.findMany({
          where: { projectId, organizationId: context.organizationId },
          orderBy: { updatedAt: 'desc' },
          include: { _count: { select: { reports: true } } },
        });

        const rows = dashboards.map((dashboard) => ({
          id: dashboard.id,
          name: dashboard.name,
          report_count: dashboard._count?.reports ?? 0,
          createdAt: dashboard.createdAt,
          updatedAt: dashboard.updatedAt,
          dashboard_url: dashboardUrl(
            context.organizationId,
            projectId,
            dashboard.id,
          ),
        }));

        return {
          dashboards: table(rows, {
            limit: limit ?? 50,
            columns: [
              'id',
              'name',
              'report_count',
              'createdAt',
              'updatedAt',
              'dashboard_url',
            ],
            sortedBy: 'updatedAt',
            unit: 'dashboards',
          }),
        };
      }),
  );

  server.tool(
    'list_reports',
    'List saved reports for a dashboard (pass dashboardId), or every report in the project (omit dashboardId). Read-only. Returns id, name, dashboardId, chartType, range, timestamps and a deep-link.',
    {
      projectId: projectIdSchema(context),
      dashboardId: z
        .string()
        .optional()
        .describe(
          'Limit to one dashboard; omit to list every report in the project',
        ),
      limit: zLimit(50, 200),
    },
    async ({ projectId: inputProjectId, dashboardId, limit }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        if (dashboardId) {
          await requireDashboard(projectId, dashboardId);
        }
        const reports = await db.report.findMany({
          where: { projectId, ...(dashboardId ? { dashboardId } : {}) },
          orderBy: { updatedAt: 'desc' },
          select: {
            id: true,
            name: true,
            dashboardId: true,
            chartType: true,
            range: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        const rows = reports.map((report) => ({
          id: report.id,
          name: report.name,
          dashboardId: report.dashboardId,
          chartType: report.chartType,
          range: report.range,
          createdAt: report.createdAt,
          updatedAt: report.updatedAt,
          report_url: reportUrl(context.organizationId, projectId, report.id),
        }));

        return {
          reports: table(rows, {
            limit: limit ?? 50,
            columns: [
              'id',
              'name',
              'dashboardId',
              'chartType',
              'range',
              'createdAt',
              'updatedAt',
              'report_url',
            ],
            sortedBy: 'updatedAt',
            unit: 'reports',
          }),
        };
      }),
  );

  // Non-destructive mutations (create / update / duplicate / layout) are
  // available to BOTH read and root clients — every tool resolves +
  // ownership-checks the project (resolveProjectId → the read client's own
  // project, or the root client's requested one), so a read token can only
  // create/edit within its own project, never across the org. The two DELETE
  // tools stay root-only (see the isRoot guards below) so a self-service token
  // can't destroy a shared dashboard or report.
  const isRoot = context.clientType === 'root';

  server.tool(
    'create_dashboard',
    'Create a dashboard in the resolved project.',
    {
      projectId: projectIdSchema(context),
      name: z.string().describe('The dashboard name'),
    },
    async ({ projectId: inputProjectId, name }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const project = await getProjectById(projectId);
        if (!project) {
          throw new Error('Project not found');
        }

        const dashboard = await db.$primary().dashboard.create({
          data: {
            id: await getId('dashboard', name),
            projectId,
            organizationId: project.organizationId,
            name,
          },
        });

        return {
          dashboard: withDashboardUrl(
            context.organizationId,
            projectId,
            dashboard,
          ),
          reports: [],
          layouts: [],
        };
      }),
  );

  server.tool(
    'update_dashboard',
    'Rename a dashboard after verifying it belongs to the resolved project.',
    {
      projectId: projectIdSchema(context),
      dashboardId: z.string().describe('The dashboard ID to update'),
      name: z.string().describe('The new dashboard name'),
    },
    async ({ projectId: inputProjectId, dashboardId, name }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        await requireDashboard(projectId, dashboardId);
        const dashboard = await db.$primary().dashboard.update({
          where: { id: dashboardId },
          data: { name },
        });

        return {
          dashboard: withDashboardUrl(
            context.organizationId,
            projectId,
            dashboard,
          ),
        };
      }),
  );

  if (isRoot) {
    server.tool(
      'delete_dashboard',
      'Delete a dashboard. Deletion fails when reports exist unless forceDelete is true; forced deletion removes the reports first.',
      {
        projectId: projectIdSchema(context),
        dashboardId: z.string().describe('The dashboard ID to delete'),
        forceDelete: z
          .boolean()
          .optional()
          .describe('Delete all reports in the dashboard before deleting it'),
      },
      async ({ projectId: inputProjectId, dashboardId, forceDelete }) =>
        withErrorHandling(async () => {
          const projectId = await resolveProjectId(context, inputProjectId);
          const dashboard = await requireDashboard(projectId, dashboardId);

          try {
            await db.$primary().$transaction(async (transaction) => {
              const current = await transaction.dashboard.findFirst({
                where: { id: dashboardId, projectId },
              });
              if (!current) {
                throw new Error('Dashboard not found');
              }

              const reports = await transaction.report.findMany({
                where: { dashboardId, projectId },
                select: { id: true },
              });
              if (reports.length > 0 && !forceDelete) {
                throw new Error(
                  'Cannot delete dashboard with associated reports',
                );
              }

              if (forceDelete && reports.length > 0) {
                const reportIds = reports.map((report) => report.id);
                // Layouts hold the foreign key to reports, so they go first —
                // this order stays correct even if that cascade ever changes.
                await transaction.reportLayout.deleteMany({
                  where: { reportId: { in: reportIds } },
                });
                await transaction.report.deleteMany({
                  where: { id: { in: reportIds } },
                });
              }

              await transaction.dashboard.delete({
                where: { id: dashboardId },
              });
            });
          } catch (error) {
            if (
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'P2003'
            ) {
              throw new Error(
                'Cannot delete dashboard with associated reports',
              );
            }
            if (error instanceof Error) {
              throw error;
            }
            throw new Error('Unknown error deleting dashboard');
          }

          return {
            deleted: true,
            dashboard: withDashboardUrl(
              context.organizationId,
              projectId,
              dashboard,
            ),
          };
        }),
    );
  }

  server.tool(
    'create_report',
    'Create a saved chart report in a dashboard using the canonical report configuration shape.',
    {
      projectId: projectIdSchema(context),
      dashboardId: z.string().describe('The dashboard ID for the new report'),
      report: reportSchema.describe('The saved report configuration'),
    },
    async ({ projectId: inputProjectId, dashboardId, report }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const dashboard = await requireDashboard(projectId, dashboardId);
        const created = await db.$primary().report.create({
          // zChartType/zMetric are wider than the Prisma enums (they include
          // 'distribution'/'count'); cast the persisted shape like the report
          // router does.
          data: {
            projectId: dashboard.projectId,
            dashboardId,
            ...reportData(report),
          } as Prisma.ReportUncheckedCreateInput,
        });

        return {
          report: withReportUrl(context.organizationId, projectId, created),
        };
      }),
  );

  server.tool(
    'update_report',
    'Update a saved chart report after verifying it belongs to the resolved project.',
    {
      projectId: projectIdSchema(context),
      reportId: z.string().uuid().describe('The report ID to update'),
      report: reportSchema.describe('The complete saved report configuration'),
    },
    async ({ projectId: inputProjectId, reportId, report }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        await requireReport(projectId, reportId);
        const updated = await db.$primary().report.update({
          where: { id: reportId },
          data: reportData(report) as Prisma.ReportUncheckedUpdateInput,
        });

        return {
          report: withReportUrl(context.organizationId, projectId, updated),
        };
      }),
  );

  if (isRoot) {
    server.tool(
      'delete_report',
      'Delete a saved chart report after verifying it belongs to the resolved project.',
      {
        projectId: projectIdSchema(context),
        reportId: z.string().uuid().describe('The report ID to delete'),
      },
      async ({ projectId: inputProjectId, reportId }) =>
        withErrorHandling(async () => {
          const projectId = await resolveProjectId(context, inputProjectId);
          await requireReport(projectId, reportId);
          const deleted = await db.$primary().report.delete({
            where: { id: reportId },
          });

          return {
            deleted: true,
            report: withReportUrl(context.organizationId, projectId, deleted),
          };
        }),
    );
  }

  server.tool(
    'duplicate_report',
    'Duplicate a saved report in its existing dashboard.',
    {
      projectId: projectIdSchema(context),
      reportId: z.string().uuid().describe('The report ID to duplicate'),
    },
    async ({ projectId: inputProjectId, reportId }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const report: Report = await requireReport(projectId, reportId);
        const duplicate = await db.$primary().report.create({
          data: {
            projectId: report.projectId,
            dashboardId: report.dashboardId,
            name: `Copy of ${report.name}`,
            events: report.events!,
            globalFilters: report.globalFilters ?? [],
            interval: report.interval,
            breakdowns: report.breakdowns!,
            chartType: report.chartType,
            lineType: report.lineType,
            comparison: report.comparison,
            range: report.range,
            formula: report.formula,
            previous: report.previous,
            unit: report.unit,
            metric: report.metric,
            hiddenSeries: report.hiddenSeries ?? [],
            // Preserve funnel/conversion settings on the copy — these are
            // dedicated columns that must ride along or the duplicate silently
            // reverts to defaults.
            criteria: report.criteria,
            funnelGroup: report.funnelGroup,
            funnelWindow: report.funnelWindow,
            holdProperties: report.holdProperties ?? [],
            measuring: report.measuring,
            sortOrder: report.sortOrder,
            ttcAggregation: report.ttcAggregation,
            startDate: report.startDate,
            endDate: report.endDate,
          },
        });

        return {
          report: withReportUrl(context.organizationId, projectId, duplicate),
        };
      }),
  );

  server.tool(
    'update_report_layout',
    'Save or update the grid layout for a report in the resolved project.',
    {
      projectId: projectIdSchema(context),
      reportId: z
        .string()
        .uuid()
        .describe('The report ID whose layout should change'),
      layout: layoutSchema.describe('The report grid layout'),
    },
    async ({ projectId: inputProjectId, reportId, layout }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        await requireReport(projectId, reportId);
        return db.$primary().reportLayout.upsert({
          where: { reportId },
          create: { reportId, ...layout },
          update: layout,
        });
      }),
  );

  server.tool(
    'reset_dashboard_layout',
    'Delete all saved report layouts in a dashboard after binding it to the resolved project.',
    {
      projectId: projectIdSchema(context),
      dashboardId: z
        .string()
        .describe('The dashboard whose layouts should reset'),
    },
    async ({ projectId: inputProjectId, dashboardId }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        await requireDashboard(projectId, dashboardId);
        const result = await db.$primary().reportLayout.deleteMany({
          where: {
            report: {
              dashboardId,
              projectId,
            },
          },
        });

        return {
          dashboardId,
          count: result.count,
          dashboard_url: dashboardUrl(
            context.organizationId,
            projectId,
            dashboardId,
          ),
        };
      }),
  );
}
