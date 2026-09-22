import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ENGINE REGRESSION LOCK.
 *
 * The `firstTime` qualifier has to survive normalize.ts → fetch.ts and reach
 * getChartSql intact. A prior bug dropped `firstTime` in fetch.ts's queryInput,
 * so getChartSql saw `firstTime=undefined` and silently returned full totals
 * regardless of the UI toggle. These tests fail if anyone removes `firstTime`
 * from that field-forwarding again.
 */

// --- fetch.ts forwarding ------------------------------------------------------

const { getChartSqlSpy } = vi.hoisted(() => ({
  // biome-ignore lint/suspicious/noExplicitAny: capture-only spy over getChartSql
  getChartSqlSpy: vi.fn((_input: any) => Promise.resolve('SELECT 1')),
}));

vi.mock('../services/chart.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/chart.service')>();
  return { ...actual, getChartSql: getChartSqlSpy };
});

vi.mock('../services/custom-event.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/custom-event.service')>();
  return { ...actual, getCustomEventByName: vi.fn(async () => null) };
});

vi.mock('../clickhouse/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../clickhouse/client')>();
  return { ...actual, chQuery: vi.fn(async () => []) };
});

import { fetch } from './fetch';
import type { Plan } from './types';

const makePlan = (firstTime: boolean | undefined): Plan =>
  ({
    definitions: [
      {
        type: 'event',
        id: 'A',
        name: 'signup',
        segment: 'event',
        filters: [],
        firstTime,
      },
    ],
    concreteSeries: [
      {
        id: 'series-A',
        definitionId: 'A',
        definitionIndex: 0,
        name: ['signup'],
        context: { filters: [] },
        data: [],
        definition: { type: 'event', id: 'A', name: 'signup' } as any,
      },
    ],
    timezone: 'UTC',
    input: {
      projectId: 'proj_engine',
      startDate: '2024-01-01 00:00:00',
      endDate: '2024-01-31 00:00:00',
      breakdowns: [],
      interval: 'day',
      chartType: 'linear',
      metric: 'sum',
      previous: false,
      range: 'custom',
      cohortFilters: [],
      globalFilters: [],
      holdProperties: [],
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal Plan fixture
  }) as any;

describe('engine fetch.ts forwards firstTime to getChartSql', () => {
  beforeEach(() => {
    getChartSqlSpy.mockClear();
  });

  it('passes firstTime:true through to getChartSql (regression: was dropped)', async () => {
    await fetch(makePlan(true));

    expect(getChartSqlSpy).toHaveBeenCalled();
    const arg = getChartSqlSpy.mock.calls[0]![0] as {
      event: { firstTime?: boolean };
    };
    // THE lock: if fetch.ts stops forwarding event.firstTime, this is undefined
    // and the chart silently returns full totals.
    expect(arg.event.firstTime).toBe(true);
  });

  it('passes firstTime:false through unchanged', async () => {
    await fetch(makePlan(false));
    const arg = getChartSqlSpy.mock.calls[0]![0] as {
      event: { firstTime?: boolean };
    };
    expect(arg.event.firstTime).toBe(false);
  });
});

// --- normalize.ts forwarding --------------------------------------------------

vi.mock('../services/organization.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/organization.service')>();
  return {
    ...actual,
    getSettingsForProject: vi.fn(async () => ({ timezone: 'UTC' })),
  };
});

import { normalize } from './normalize';

describe('engine normalize.ts preserves firstTime', () => {
  const baseInput = {
    projectId: 'proj_engine',
    startDate: '2024-01-01 00:00:00',
    endDate: '2024-01-31 00:00:00',
    range: 'custom' as const,
    breakdowns: [],
    interval: 'day' as const,
    chartType: 'linear' as const,
  };

  it('keeps firstTime on the new-format (typed) series item', async () => {
    const result = await normalize({
      ...baseInput,
      series: [
        {
          type: 'event',
          id: 'A',
          name: 'signup',
          segment: 'event',
          filters: [],
          firstTime: true,
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal chart input fixture
    } as any);

    expect((result.series[0] as { firstTime?: boolean }).firstTime).toBe(true);
  });

  it('keeps firstTime on the old-format (untyped) event item', async () => {
    const result = await normalize({
      ...baseInput,
      events: [
        {
          id: 'A',
          name: 'signup',
          segment: 'event',
          filters: [],
          firstTime: true,
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: minimal chart input fixture
    } as any);

    expect((result.series[0] as { firstTime?: boolean }).firstTime).toBe(true);
  });
});
