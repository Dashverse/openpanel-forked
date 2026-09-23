import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mockDb = vi.hoisted(() => {
  const db: any = {
    $transaction: vi.fn(),
    // Read-replica extension: writes route through $primary(); in tests it
    // resolves back to the same mock so every delegate call is observable.
    $primary: vi.fn(() => db),
    dashboard: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    report: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    reportLayout: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  return db;
});

const mockGetDashboardById = vi.hoisted(() => vi.fn());
const mockGetProjectById = vi.hoisted(() => vi.fn());
const mockGetId = vi.hoisted(() => vi.fn());

vi.mock('@openpanel/db', () => ({
  Prisma: { DbNull: { kind: 'DbNull' } },
  db: mockDb,
  getDashboardById: mockGetDashboardById,
  getProjectById: mockGetProjectById,
  getId: mockGetId,
  // shared.ts routes every tool's work through this; keep it a passthrough.
  runWithMcpClient: vi.fn((fn: () => unknown) => fn()),
  resolveClientProjectId: vi.fn(
    ({
      clientProjectId,
      inputProjectId,
    }: {
      clientProjectId: string | null;
      inputProjectId?: string;
    }) => Promise.resolve(clientProjectId ?? inputProjectId),
  ),
}));

import type { McpAuthContext } from '../auth';
import { registerDashboardManagementTools } from './dashboard-management';

type Handler = (input: any) => Promise<any>;

function makeServer() {
  const handlers = new Map<string, Handler>();
  const schemas = new Map<string, any>();
  return {
    tool: (
      name: string,
      _description: string,
      schema: any,
      handler: Handler,
    ) => {
      handlers.set(name, handler);
      schemas.set(name, schema);
    },
    invoke: async (name: string, input: any) => {
      const schema = schemas.get(name);
      const parsed = z.object(schema).parse(input);
      const result = await handlers.get(name)!(parsed);
      const text = result.content[0].text;
      return result.isError ? { error: text } : JSON.parse(text);
    },
    schema(name: string) {
      return schemas.get(name);
    },
    names() {
      return [...schemas.keys()];
    },
  };
}

const READ_CONTEXT = {
  projectId: 'project-1',
  organizationId: 'organization-1',
  clientType: 'read' as const,
  clientId: 'client-read',
};

const ROOT_CONTEXT = {
  projectId: null,
  organizationId: 'organization-1',
  clientType: 'root' as const,
  clientId: 'client-root',
};

const DASHBOARD = {
  id: 'dashboard-1',
  projectId: 'project-1',
  organizationId: 'organization-1',
  name: 'Product',
  project: { id: 'project-1' },
};

// Fork divergence: the reports table has `hiddenSeries` and no
// `visibleSeries`/`options` columns.
const REPORT = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: 'project-1',
  dashboardId: 'dashboard-1',
  name: 'Signups',
  events: [],
  globalFilters: [],
  interval: 'day',
  breakdowns: [],
  chartType: 'linear',
  lineType: 'monotone',
  range: '30d',
  formula: null,
  previous: false,
  unit: null,
  metric: 'sum',
  hiddenSeries: [],
  startDate: null,
  endDate: null,
  layout: null,
};

// Fork divergence: our zChartEventFilter models `cohortId` (single) but not the
// upstream `type`/`cohortIds` fields, so those would be stripped on save. This
// fixture uses only fields the fork's schema round-trips losslessly.
const EVENT_WITH_COHORT_FILTER = {
  type: 'event',
  name: 'signup',
  segment: 'event',
  filters: [
    {
      id: 'A',
      name: 'plan',
      operator: 'is',
      value: ['pro'],
      cohortId: 'legacy-cohort',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.$primary.mockImplementation(() => mockDb);
  mockGetDashboardById.mockResolvedValue(DASHBOARD);
  mockGetProjectById.mockResolvedValue({
    id: 'project-1',
    organizationId: 'organization-1',
  });
  mockGetId.mockResolvedValue('dashboard-2');
  mockDb.dashboard.create.mockResolvedValue({
    ...DASHBOARD,
    id: 'dashboard-2',
  });
  mockDb.dashboard.findFirst.mockResolvedValue(DASHBOARD);
  mockDb.dashboard.findMany.mockResolvedValue([]);
  mockDb.dashboard.update.mockResolvedValue({ ...DASHBOARD, name: 'Renamed' });
  mockDb.report.findFirst.mockResolvedValue(REPORT);
  mockDb.report.findMany.mockResolvedValue([]);
  mockDb.report.create.mockResolvedValue(REPORT);
  mockDb.report.update.mockResolvedValue(REPORT);
  mockDb.report.delete.mockResolvedValue(REPORT);
  mockDb.report.deleteMany.mockResolvedValue({ count: 1 });
  mockDb.reportLayout.upsert.mockResolvedValue({ reportId: REPORT.id, x: 1 });
  mockDb.reportLayout.deleteMany.mockResolvedValue({ count: 1 });
  mockDb.$transaction.mockImplementation(async (callback: any) =>
    callback(mockDb),
  );
});

function register(context: McpAuthContext = ROOT_CONTEXT) {
  const server = makeServer();
  registerDashboardManagementTools(server as any, context);
  return server;
}

function validReport(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Signups',
    series: [],
    ...overrides,
  };
}

describe('dashboard management registration', () => {
  it('registers reads (get + lists) for read credentials', () => {
    expect(register(READ_CONTEXT).names()).toEqual([
      'get_dashboard',
      'list_dashboards',
      'list_reports',
    ]);
  });

  it('registers all management tools for root credentials', () => {
    expect(register().names()).toEqual([
      'get_dashboard',
      'list_dashboards',
      'list_reports',
      'create_dashboard',
      'update_dashboard',
      'delete_dashboard',
      'create_report',
      'update_report',
      'delete_report',
      'duplicate_report',
      'update_report_layout',
      'reset_dashboard_layout',
    ]);
  });

  it('uses a strict persistable report schema with defaults', () => {
    const server = register();
    const reportSchema = server.schema('create_report').report;

    expect(reportSchema.parse(validReport())).toMatchObject({
      chartType: 'linear',
      interval: 'day',
      range: '30d',
      previous: false,
      metric: 'sum',
      lineType: 'monotone',
    });
    expect(reportSchema.safeParse({ name: 'Missing series' }).success).toBe(
      false,
    );
    expect(reportSchema.safeParse(validReport({ limit: 10 })).success).toBe(
      false,
    );
    expect(reportSchema.safeParse(validReport({ offset: 10 })).success).toBe(
      false,
    );
  });

  it('requires valid ordered dates for custom ranges', () => {
    const reportSchema = register().schema('create_report').report;

    expect(
      reportSchema.safeParse(validReport({ range: 'custom' })).success,
    ).toBe(false);
    expect(
      reportSchema.safeParse(
        validReport({
          range: 'custom',
          startDate: '2026-02-30',
          endDate: '2026-03-01',
        }),
      ).success,
    ).toBe(false);
    expect(
      reportSchema.safeParse(
        validReport({
          range: 'custom',
          startDate: '2026-03-02',
          endDate: '2026-03-01',
        }),
      ).success,
    ).toBe(false);
  });
});

describe('dashboard management project binding', () => {
  it('binds dashboard reads to the resolved project', async () => {
    const server = register(READ_CONTEXT);

    await server.invoke('get_dashboard', {
      projectId: 'another-project',
      dashboardId: 'dashboard-1',
    });

    expect(mockGetDashboardById).toHaveBeenCalledWith(
      'dashboard-1',
      'project-1',
    );
    expect(mockDb.report.findMany).toHaveBeenCalledWith({
      where: { dashboardId: 'dashboard-1', projectId: 'project-1' },
      include: { layout: true },
    });
  });

  it('rejects a report id that is not a uuid before touching the database', async () => {
    const server = register();

    await expect(
      server.invoke('delete_report', {
        projectId: 'project-1',
        reportId: 'dashboard-1',
      }),
    ).rejects.toThrow();
    expect(mockDb.report.findFirst).not.toHaveBeenCalled();
  });

  it('does not mutate a report from another project', async () => {
    mockDb.report.findFirst.mockResolvedValue(null);
    const server = register();

    const result = await server.invoke('delete_report', {
      projectId: 'project-1',
      reportId: '22222222-2222-4222-8222-222222222222',
    });

    expect(result.error).toContain('Report not found');
    expect(mockDb.report.delete).not.toHaveBeenCalled();
    expect(mockDb.report.findFirst).toHaveBeenCalledWith({
      where: {
        id: '22222222-2222-4222-8222-222222222222',
        projectId: 'project-1',
      },
    });
  });
});

describe('dashboard management behavior', () => {
  it('persists custom dates and router defaults after schema parsing', async () => {
    const server = register();

    await server.invoke('create_report', {
      projectId: 'project-1',
      dashboardId: 'dashboard-1',
      report: validReport({
        range: 'custom',
        startDate: '2026-01-01',
        endDate: '2026-01-31',
      }),
    });

    expect(mockDb.report.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'project-1',
        dashboardId: 'dashboard-1',
        globalFilters: [],
        hiddenSeries: [],
        startDate: '2026-01-01',
        endDate: '2026-01-31',
      }),
    });
  });

  it('clears optional persisted report values on full replacement', async () => {
    const server = register();

    await server.invoke('update_report', {
      projectId: 'project-1',
      reportId: '11111111-1111-4111-8111-111111111111',
      report: validReport(),
    });

    expect(mockDb.report.update).toHaveBeenCalledWith({
      where: { id: '11111111-1111-4111-8111-111111111111' },
      data: expect.objectContaining({
        formula: null,
        unit: null,
        startDate: null,
        endDate: null,
      }),
    });
  });

  it('returns a lossless report configuration for get→update round trips', async () => {
    const report = {
      ...REPORT,
      events: [EVENT_WITH_COHORT_FILTER],
      globalFilters: [
        {
          name: 'country',
          operator: 'is',
          value: ['SE'],
          cohortId: 'cohort-global',
        },
      ],
    };
    mockDb.report.findMany.mockResolvedValue([report]);
    const readServer = register(READ_CONTEXT);
    const dashboard = await readServer.invoke('get_dashboard', {
      dashboardId: 'dashboard-1',
    });
    const configuration = dashboard.reports[0].report;

    expect(configuration.series).toEqual(report.events);
    expect(configuration.globalFilters).toEqual(report.globalFilters);

    const rootServer = register();
    await rootServer.invoke('update_report', {
      projectId: 'project-1',
      reportId: '11111111-1111-4111-8111-111111111111',
      report: configuration,
    });

    expect(mockDb.report.update).toHaveBeenCalledWith({
      where: { id: '11111111-1111-4111-8111-111111111111' },
      data: expect.objectContaining({
        events: report.events,
        globalFilters: report.globalFilters,
      }),
    });
  });

  it('rejects a non-empty dashboard atomically without force', async () => {
    mockDb.report.findMany.mockResolvedValue([
      { id: '11111111-1111-4111-8111-111111111111', projectId: 'project-1' },
    ]);
    const server = register();

    const result = await server.invoke('delete_dashboard', {
      projectId: 'project-1',
      dashboardId: 'dashboard-1',
    });

    expect(result.error).toContain(
      'Cannot delete dashboard with associated reports',
    );
    expect(mockDb.$transaction).toHaveBeenCalled();
    expect(mockDb.dashboard.delete).not.toHaveBeenCalled();
  });

  it('force deletes reports and their layouts in one transaction', async () => {
    mockDb.report.findMany.mockResolvedValue([
      { id: '11111111-1111-4111-8111-111111111111', projectId: 'project-1' },
    ]);
    const server = register();

    await server.invoke('delete_dashboard', {
      projectId: 'project-1',
      dashboardId: 'dashboard-1',
      forceDelete: true,
    });

    expect(mockDb.report.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['11111111-1111-4111-8111-111111111111'] } },
    });
    expect(mockDb.reportLayout.deleteMany).toHaveBeenCalledWith({
      where: { reportId: { in: ['11111111-1111-4111-8111-111111111111'] } },
    });
    expect(
      mockDb.reportLayout.deleteMany.mock.invocationCallOrder[0]!,
    ).toBeLessThan(mockDb.report.deleteMany.mock.invocationCallOrder[0]!);
    expect(mockDb.dashboard.delete).toHaveBeenCalledWith({
      where: { id: 'dashboard-1' },
    });
  });

  it('duplicates a bound report without losing custom dates', async () => {
    mockDb.report.findFirst.mockResolvedValue({
      ...REPORT,
      events: [EVENT_WITH_COHORT_FILTER],
      range: 'custom',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });
    const server = register();

    await server.invoke('duplicate_report', {
      projectId: 'project-1',
      reportId: '11111111-1111-4111-8111-111111111111',
    });

    expect(mockDb.report.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Copy of Signups',
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        events: [EVENT_WITH_COHORT_FILTER],
      }),
    });
  });

  it('scopes reset layout deletion to the resolved project dashboard', async () => {
    const server = register();

    await server.invoke('reset_dashboard_layout', {
      projectId: 'project-1',
      dashboardId: 'dashboard-1',
    });

    expect(mockDb.reportLayout.deleteMany).toHaveBeenCalledWith({
      where: {
        report: { dashboardId: 'dashboard-1', projectId: 'project-1' },
      },
    });
  });

  it('rejects invalid layouts before the handler executes and persists valid ones', async () => {
    const server = register();

    await expect(
      server.invoke('update_report_layout', {
        projectId: 'project-1',
        reportId: '11111111-1111-4111-8111-111111111111',
        layout: { x: -1, y: 0, w: 4, h: 3 },
      }),
    ).rejects.toThrow();
    expect(mockDb.reportLayout.upsert).not.toHaveBeenCalled();

    await server.invoke('update_report_layout', {
      projectId: 'project-1',
      reportId: '11111111-1111-4111-8111-111111111111',
      layout: { x: 1, y: 2, w: 4, h: 3, minW: 2, minH: 2, maxW: 8, maxH: 8 },
    });
    expect(mockDb.reportLayout.upsert).toHaveBeenCalledWith({
      where: { reportId: '11111111-1111-4111-8111-111111111111' },
      create: {
        reportId: '11111111-1111-4111-8111-111111111111',
        x: 1,
        y: 2,
        w: 4,
        h: 3,
        minW: 2,
        minH: 2,
        maxW: 8,
        maxH: 8,
      },
      update: { x: 1, y: 2, w: 4, h: 3, minW: 2, minH: 2, maxW: 8, maxH: 8 },
    });
  });
});

describe('dashboard and report listing', () => {
  it('lists dashboards for a read client with a report count and deep-link', async () => {
    mockDb.dashboard.findMany.mockResolvedValue([
      {
        id: 'dashboard-1',
        name: 'Product',
        organizationId: 'organization-1',
        projectId: 'project-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        _count: { reports: 3 },
      },
    ]);
    const server = register(READ_CONTEXT);

    const result = await server.invoke('list_dashboards', {});

    // Read clients have projectId fixed in context, so it scopes to project-1.
    expect(mockDb.dashboard.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1', organizationId: 'organization-1' },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { reports: true } } },
    });
    expect(result.dashboards.columns).toEqual([
      'id',
      'name',
      'report_count',
      'createdAt',
      'updatedAt',
      'dashboard_url',
    ]);
    expect(result.dashboards.rows).toEqual([
      [
        'dashboard-1',
        'Product',
        3,
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        '/organization-1/project-1/dashboards/dashboard-1',
      ],
    ]);
  });

  it('lists reports for a dashboard for a read client', async () => {
    mockDb.report.findMany.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Signups',
        dashboardId: 'dashboard-1',
        chartType: 'funnel',
        range: '30d',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
    const server = register(READ_CONTEXT);

    const result = await server.invoke('list_reports', {
      dashboardId: 'dashboard-1',
    });

    // A dashboardId narrows the query and is verified against the project first.
    expect(mockGetDashboardById).toHaveBeenCalledWith(
      'dashboard-1',
      'project-1',
    );
    expect(mockDb.report.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1', dashboardId: 'dashboard-1' },
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
    expect(result.reports.rows).toEqual([
      [
        '11111111-1111-4111-8111-111111111111',
        'Signups',
        'dashboard-1',
        'funnel',
        '30d',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        '/organization-1/project-1/reports/11111111-1111-4111-8111-111111111111',
      ],
    ]);
  });

  it('lists all reports in the project when dashboardId is omitted', async () => {
    mockDb.report.findMany.mockResolvedValue([]);
    const server = register(READ_CONTEXT);

    await server.invoke('list_reports', {});

    expect(mockGetDashboardById).not.toHaveBeenCalled();
    expect(mockDb.report.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1' },
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
  });
});

describe('report configuration is lossless', () => {
  // A full funnel report: window + grouping key + Hold Property Constant +
  // a step-scoped breakdown + a per-event filter + conversion measurement.
  const FULL_FUNNEL_REPORT = {
    name: 'Onboarding funnel',
    chartType: 'funnel',
    series: [
      {
        type: 'event',
        name: 'signup',
        segment: 'event',
        filters: [{ id: 'A', name: 'plan', operator: 'is', value: ['pro'] }],
      },
      {
        type: 'event',
        name: 'activated',
        segment: 'event',
        filters: [],
      },
    ],
    breakdowns: [{ name: 'country', step: 2 }],
    funnelWindow: 72,
    funnelGroup: 'session_id',
    holdProperties: ['country', 'plan'],
    criteria: 'on_or_after',
    measuring: 'time_to_convert',
    ttcAggregation: 'p90',
    sortOrder: 'asc',
    comparison: 'overall',
    interval: 'week',
    range: '30d',
    metric: 'sum',
    lineType: 'monotone',
  };

  it('persists every funnel/conversion setting through create_report', async () => {
    const server = register();

    await server.invoke('create_report', {
      projectId: 'project-1',
      dashboardId: 'dashboard-1',
      report: FULL_FUNNEL_REPORT,
    });

    expect(mockDb.report.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'project-1',
        dashboardId: 'dashboard-1',
        name: 'Onboarding funnel',
        chartType: 'funnel',
        // series → events, including the per-event filter, verbatim.
        events: FULL_FUNNEL_REPORT.series,
        // Breakdown step survives (it lives in the breakdowns jsonb).
        breakdowns: [{ name: 'country', step: 2 }],
        // Funnel-specific columns.
        funnelWindow: 72,
        funnelGroup: 'session_id',
        holdProperties: ['country', 'plan'],
        criteria: 'on_or_after',
        // Conversion/measurement columns.
        measuring: 'time_to_convert',
        ttcAggregation: 'p90',
        sortOrder: 'asc',
        comparison: 'overall',
        interval: 'week',
      }),
    });

    // None of the funnel/conversion settings may be dropped from the write.
    const persisted = mockDb.report.create.mock.calls[0]![0].data;
    for (const key of [
      'funnelWindow',
      'funnelGroup',
      'holdProperties',
      'criteria',
      'measuring',
      'ttcAggregation',
      'sortOrder',
      'comparison',
    ]) {
      expect(persisted).toHaveProperty(key);
    }
  });

  it('persists every funnel/conversion setting through update_report', async () => {
    const server = register();

    await server.invoke('update_report', {
      projectId: 'project-1',
      reportId: '11111111-1111-4111-8111-111111111111',
      report: FULL_FUNNEL_REPORT,
    });

    expect(mockDb.report.update).toHaveBeenCalledWith({
      where: { id: '11111111-1111-4111-8111-111111111111' },
      data: expect.objectContaining({
        events: FULL_FUNNEL_REPORT.series,
        breakdowns: [{ name: 'country', step: 2 }],
        funnelWindow: 72,
        funnelGroup: 'session_id',
        holdProperties: ['country', 'plan'],
        criteria: 'on_or_after',
        measuring: 'time_to_convert',
        ttcAggregation: 'p90',
        sortOrder: 'asc',
        comparison: 'overall',
      }),
    });
  });
});
