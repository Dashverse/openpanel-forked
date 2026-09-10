import { describe, expect, it } from 'vitest';
import type { IChartEventFilter } from '@openpanel/validation';
import {
  dashboardFiltersEqual,
  mergeDashboardFilters,
  parseSavedDashboardFilters,
} from './merge-dashboard-filters';

const f = (
  name: string,
  value: (string | number)[] = [],
  operator: IChartEventFilter['operator'] = 'is',
  extra: Partial<IChartEventFilter> = {},
): IChartEventFilter =>
  ({ id: name, name, operator, value, ...extra }) as IChartEventFilter;

describe('mergeDashboardFilters', () => {
  it('returns report filters unchanged when there are no dashboard filters', () => {
    const report = [f('platform', ['web'])];
    expect(mergeDashboardFilters(report, [])).toEqual(report);
    expect(mergeDashboardFilters(report, undefined as any)).toEqual(report);
  });

  it('AND-stacks distinct-property dashboard filters onto report filters', () => {
    const out = mergeDashboardFilters([f('platform', ['web'])], [f('country', ['US'])]);
    expect(out.map((x) => x.name).sort()).toEqual(['country', 'platform']);
  });

  it('dashboard WINS on same-property conflict (drops the report clause)', () => {
    const out = mergeDashboardFilters([f('country', ['CA'])], [f('country', ['US'])]);
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toEqual(['US']);
  });

  it('applies dashboard filters when the report has none', () => {
    expect(mergeDashboardFilters([], [f('country', ['US'])])).toEqual([
      f('country', ['US']),
    ]);
  });
});

describe('parseSavedDashboardFilters', () => {
  it('returns [] for non-arrays / junk', () => {
    expect(parseSavedDashboardFilters(null)).toEqual([]);
    expect(parseSavedDashboardFilters('nope')).toEqual([]);
    expect(parseSavedDashboardFilters({})).toEqual([]);
  });

  it('parses valid filters and defaults id to name', () => {
    const out = parseSavedDashboardFilters([
      { name: 'country', operator: 'is', value: ['US'] },
    ]);
    expect(out).toEqual([{ id: 'country', name: 'country', operator: 'is', value: ['US'] }]);
  });

  it('drops malformed entries but keeps valid ones', () => {
    const out = parseSavedDashboardFilters([
      null,
      42,
      { operator: 'is' }, // no name
      { name: 'x' }, // no operator
      { name: 'country', operator: 'is', value: ['US'] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('country');
  });

  it('preserves cohortId and coerces non-array value to []', () => {
    const out = parseSavedDashboardFilters([
      { name: 'cohort:abc', operator: 'inCohort', cohortId: 'abc', value: 'oops' },
    ]);
    expect(out[0]!.cohortId).toBe('abc');
    expect(out[0]!.value).toEqual([]);
  });
});

describe('dashboardFiltersEqual (Save dirty-detection)', () => {
  it('is order- and id-insensitive', () => {
    const a = [f('country', ['US']), f('platform', ['web'])];
    const b = [
      { ...f('platform', ['web']), id: 'different' },
      f('country', ['US']),
    ];
    expect(dashboardFiltersEqual(a, b)).toBe(true);
  });

  it('empty === empty (Save hidden)', () => {
    expect(dashboardFiltersEqual([], [])).toBe(true);
  });

  it('empty !== non-empty (Save shows after adding)', () => {
    expect(dashboardFiltersEqual([], [f('country', ['US'])])).toBe(false);
  });

  it('detects a value change (Save shows after edit)', () => {
    expect(
      dashboardFiltersEqual([f('country', ['US'])], [f('country', ['IN'])]),
    ).toBe(false);
  });

  it('detects removal (Save shows so the deletion can be persisted)', () => {
    const saved = [f('country', ['US']), f('platform', ['web'])];
    const afterRemove = [f('platform', ['web'])];
    expect(dashboardFiltersEqual(afterRemove, saved)).toBe(false);
  });
});
