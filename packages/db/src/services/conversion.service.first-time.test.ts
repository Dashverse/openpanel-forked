import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// getConversionCore's only external calls.
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

import { ConversionService, getConversionCore } from './conversion.service';

const PROJECT = 'proj_conv';

// buildArrayPatternSql is a pure, synchronous SQL builder — no client needed.
const service = new ConversionService({} as any);
const buildArray = (args: Record<string, unknown>): string =>
  (service as any).buildArrayPatternSql({
    projectId: PROJECT,
    startDate: '2024-01-01 00:00:00',
    endDate: '2024-01-31 00:00:00',
    extendedEndDate: '2024-02-01 00:00:00',
    funnelWindowSeconds: 86400,
    interval: 'day',
    ...args,
  });

const ev = (name: string, firstTime?: boolean) => ({
  id: name,
  type: 'event' as const,
  name,
  segment: 'user' as const,
  filters: [],
  ...(firstTime ? { firstTime: true } : {}),
});

describe('ConversionService.buildArrayPatternSql — first-time gates', () => {
  const priorDict = process.env.PROFILE_ALIAS_DICT;
  beforeEach(() => {
    process.env.PROFILE_ALIAS_DICT = '';
  });
  afterEach(() => {
    if (priorDict === undefined) {
      // biome-ignore lint/performance/noDelete: restore pristine env
      delete process.env.PROFILE_ALIAS_DICT;
    } else {
      process.env.PROFILE_ALIAS_DICT = priorDict;
    }
  });

  it('gates OPENS on the from event when firstTime is set on it', () => {
    const sql = buildArray({
      firstEvent: ev('app_open', true),
      lastEvent: ev('purchase'),
    });

    // Array-pattern path uses groupArrayIf; the open gate rides the opens leg.
    expect(sql).toContain('groupArrayIf');
    expect(sql).toContain('(events.profile_id, events.created_at) IN (');
    expect(sql).toContain('argMinIf(e.profile_id, created_at,');
    // Exactly one first-time subquery, and it is for the FROM event.
    expect(sql.split('argMinIf').length - 1).toBe(1);
    expect(sql).toContain("name = 'app_open'\n"); // inside the subquery WHERE
  });

  it('gates FINISHES on the to event when firstTime is set on it', () => {
    const sql = buildArray({
      firstEvent: ev('app_open'),
      lastEvent: ev('purchase', true),
    });

    expect(sql).toContain('(events.profile_id, events.created_at) IN (');
    expect(sql.split('argMinIf').length - 1).toBe(1);
    // The single subquery is for the TO event.
    expect(sql).toMatch(/argMinIf[\s\S]*name = 'purchase'/);
  });

  it('gates BOTH opens and finishes when both events are first-time', () => {
    const sql = buildArray({
      firstEvent: ev('app_open', true),
      lastEvent: ev('purchase', true),
    });
    expect(sql.split('argMinIf').length - 1).toBe(2);
    expect(sql).toMatch(/name = 'app_open'/);
    expect(sql).toMatch(/name = 'purchase'/);
  });

  it('emits no first-time subquery when neither event is first-time', () => {
    const sql = buildArray({
      firstEvent: ev('app_open'),
      lastEvent: ev('purchase'),
    });
    expect(sql).not.toContain('argMinIf');
  });
});

describe('getConversionCore — firstTimeSteps mapping', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps firstTimeSteps names to firstTime:true on the built series', async () => {
    const spy = vi
      .spyOn(ConversionService.prototype, 'getConversion')
      .mockResolvedValue([] as any);

    await getConversionCore({
      projectId: PROJECT,
      startDate: '2024-01-01',
      endDate: '2024-01-31',
      steps: ['app_open', 'purchase'],
      firstTimeSteps: ['app_open'],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const series = (spy.mock.calls[0]![0] as { series: any[] }).series;
    const from = series.find((s) => s.name === 'app_open');
    const to = series.find((s) => s.name === 'purchase');
    expect(from.firstTime).toBe(true);
    expect(to.firstTime).toBeUndefined();
  });
});
