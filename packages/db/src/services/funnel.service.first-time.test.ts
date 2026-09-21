import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Regular (non-custom) events → getCustomEventByName must resolve to null so the
// funnel takes the plain events-table path (and hasFirstTimeStep can be true).
vi.mock('./custom-event.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./custom-event.service')>();
  return { ...actual, getCustomEventByName: vi.fn(async () => null) };
});

// getFunnelCore's only external calls.
vi.mock('./organization.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./organization.service')>();
  return {
    ...actual,
    getSettingsForProject: vi.fn(async () => ({ timezone: 'UTC' })),
  };
});
vi.mock('./chart.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chart.service')>();
  return { ...actual, assertEventNamesExist: vi.fn(async () => undefined) };
});

import { FunnelService, getFunnelCore } from './funnel.service';

// A ClickHouse client stub that records every query it is asked to run and
// returns an empty result set — so getFunnel builds and "executes" real SQL
// without touching a database.
function capturingClient() {
  const queries: string[] = [];
  return {
    queries,
    client: {
      query: async ({ query }: { query: string }) => {
        queries.push(query);
        return { json: async () => ({ data: [], meta: [] }) };
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal ch client stub
    } as any,
  };
}

const baseFunnelInput = (series: unknown[]) =>
  ({
    projectId: 'proj_funnel',
    startDate: '2024-01-01 00:00:00',
    endDate: '2024-01-31 00:00:00',
    series,
    breakdowns: [],
    interval: 'day',
    range: 'custom',
    chartType: 'funnel',
    previous: false,
    metric: 'sum',
    funnelWindow: 24,
    funnelGroup: 'profile_id',
    timezone: 'UTC',
    // biome-ignore lint/suspicious/noExplicitAny: minimal funnel input fixture
  }) as any;

describe('FunnelService.getFunnel — first-time step', () => {
  const priorDict = process.env.PROFILE_ALIAS_DICT;

  beforeEach(() => {
    process.env.PROFILE_ALIAS_DICT = ''; // dict OFF (deterministic)
  });
  afterEach(() => {
    if (priorDict === undefined) {
      // biome-ignore lint/performance/noDelete: restore pristine env
      delete process.env.PROFILE_ALIAS_DICT;
    } else {
      process.env.PROFILE_ALIAS_DICT = priorDict;
    }
  });

  it('constrains only the first-time step with the all-time-first IN subquery', async () => {
    const { queries, client } = capturingClient();
    const service = new FunnelService(client);

    await service.getFunnel(
      baseFunnelInput([
        {
          type: 'event',
          id: '1',
          name: 'signup',
          segment: 'user',
          filters: [],
          firstTime: true,
        },
        {
          type: 'event',
          id: '2',
          name: 'purchase',
          segment: 'user',
          filters: [],
        },
      ]),
    );

    const main = queries.find((q) => q.includes('windowFunnel')) ?? '';
    expect(main).not.toBe('');

    // The first-time gate is injected into that step's windowFunnel condition:
    // the outer tuple is qualified to the funnel's fromClause (`events`), while
    // the subquery scans under its own alias (`e`).
    expect(main).toContain('(events.profile_id, events.created_at) IN (');
    expect(main).toContain('argMinIf(e.profile_id, created_at,');
    // Exactly one step is first-time → exactly one all-time-first subquery.
    expect(main.split('argMinIf').length - 1).toBe(1);
    // Both step names are still present in the funnel conditions.
    expect(main).toContain("name = 'signup'");
    expect(main).toContain("name = 'purchase'");
  });

  it('emits no first-time subquery when no step is first-time', async () => {
    const { queries, client } = capturingClient();
    const service = new FunnelService(client);

    await service.getFunnel(
      baseFunnelInput([
        {
          type: 'event',
          id: '1',
          name: 'signup',
          segment: 'user',
          filters: [],
        },
        {
          type: 'event',
          id: '2',
          name: 'purchase',
          segment: 'user',
          filters: [],
        },
      ]),
    );

    const main = queries.find((q) => q.includes('windowFunnel')) ?? '';
    expect(main).not.toBe('');
    expect(main).not.toContain('argMinIf');
  });
});

describe('getFunnelCore — firstTimeSteps mapping', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps firstTimeSteps names to firstTime:true on the built series', async () => {
    const spy = vi
      .spyOn(FunnelService.prototype, 'getFunnel')
      .mockResolvedValue([] as any);

    await getFunnelCore({
      projectId: 'proj_funnel',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
      steps: ['signup', 'purchase'],
      firstTimeSteps: ['signup'],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const series = (spy.mock.calls[0]![0] as { series: any[] }).series;
    const signup = series.find((s) => s.name === 'signup');
    const purchase = series.find((s) => s.name === 'purchase');
    expect(signup.firstTime).toBe(true);
    // Steps NOT listed carry no firstTime key.
    expect(purchase.firstTime).toBeUndefined();
  });
});
