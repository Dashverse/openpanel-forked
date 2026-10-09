import type { IChartEventFilter } from '@openpanel/validation';
import { describe, expect, it } from 'vitest';
import { getEventFiltersWhereClause } from './chart.service';

const f = (
  name: string,
  value: string[],
  operator: IChartEventFilter['operator'] = 'is',
  extra: Partial<IChartEventFilter> = {},
): IChartEventFilter => ({ id: name, name, operator, value, ...extra });

const country = f('country', ['US']);
const os = f('os', ['iOS']);

describe('getEventFiltersWhereClause match all / match any', () => {
  it('defaults to AND: one clause per filter, unchanged', () => {
    const where = getEventFiltersWhereClause([country, os]);
    expect(where).toEqual({ f0: "country = 'US'", f1: "os = 'iOS'" });
    expect(getEventFiltersWhereClause([country, os], undefined, 'and')).toEqual(
      where,
    );
  });

  it('OR with 2 property filters => exactly one (a OR b) clause', () => {
    const where = getEventFiltersWhereClause([country, os], undefined, 'or');
    expect(Object.values(where)).toEqual(["(country = 'US' OR os = 'iOS')"]);
  });

  it('OR with 1 filter => unchanged', () => {
    expect(getEventFiltersWhereClause([country], undefined, 'or')).toEqual(
      getEventFiltersWhereClause([country]),
    );
  });

  it('OR keeps cohort filters as separate required clauses', () => {
    const cohort = f('cohort', [], 'inCohort', { cohortId: 'co-1' });
    const where = getEventFiltersWhereClause([country, cohort, os], 'p1', 'or');
    expect(Object.values(where).sort()).toEqual(
      [
        "(country = 'US' OR os = 'iOS')",
        'notEmpty(cohort_co_1.profile_id)',
      ].sort(),
    );
  });

  it('OR keeps merged report/dashboard (global) filters ANDed', () => {
    const where = getEventFiltersWhereClause(
      [country, os, { ...f('device', ['mobile']), isGlobal: true }],
      undefined,
      'or',
    );
    expect(Object.values(where).sort()).toEqual(
      ["(country = 'US' OR os = 'iOS')", "device = 'mobile'"].sort(),
    );
  });
});
