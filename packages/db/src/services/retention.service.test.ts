import { describe, expect, it } from 'vitest';
import type { IChartEventFilter } from '@openpanel/validation';
import { buildRetentionQuery, processRetentionData } from './retention.service';

const base = {
  projectId: 'p1',
  firstEvent: ['showOpen'],
  secondEvent: ['appOpen'],
  criteria: 'on_or_after' as const,
  interval: 'day' as const,
  startDate: '2026-09-01 00:00:00',
  endDate: '2026-09-08 00:00:00',
};

const f = (
  name: string,
  value: (string | number)[],
  operator: IChartEventFilter['operator'] = 'is',
  extra: Partial<IChartEventFilter> = {},
): IChartEventFilter => ({ id: name, name, operator, value, ...extra });

// Split the generated SQL into the cohort-defining CTE and the return CTE so we
// can assert a filter landed on the right side.
function ctes(sql: string) {
  const cohortStart = sql.indexOf('cohort_users AS');
  const lastStart = sql.indexOf('last_event AS');
  const matrixStart = sql.indexOf('retention_matrix AS');
  return {
    cohort: sql.slice(cohortStart, lastStart),
    lastEvent: sql.slice(lastStart, matrixStart),
  };
}

describe('buildRetentionQuery', () => {
  it('builds the cohort/return structure over events; no filters => no filter clauses', () => {
    const { sql, diffInterval } = buildRetentionQuery(base);
    expect(diffInterval).toBe(7); // 2026-09-01 -> 2026-09-08 = 7 days
    const { cohort, lastEvent } = ctes(sql);
    expect(cohort).toContain("name = 'showOpen'");
    expect(lastEvent).toContain("name = 'appOpen'");
    expect(sql).toContain('FROM events');
    // identity resolution: dict off in tests -> raw profile_id
    expect(sql).toContain('events.profile_id');
    expect(cohort).not.toContain('country');
    expect(lastEvent).not.toContain('country');
  });

  it('applies firstEventFilters only to the cohort event', () => {
    const { sql } = buildRetentionQuery({
      ...base,
      firstEventFilters: [f('country', ['US'])],
    });
    const { cohort, lastEvent } = ctes(sql);
    expect(cohort).toContain("country = 'US'");
    expect(lastEvent).not.toContain('country');
  });

  it('applies secondEventFilters only to the return event', () => {
    const { sql } = buildRetentionQuery({
      ...base,
      secondEventFilters: [f('os', ['iOS'])],
    });
    const { cohort, lastEvent } = ctes(sql);
    expect(lastEvent).toContain("os = 'iOS'");
    expect(cohort).not.toContain('os =');
  });

  it('applies first and second filters independently', () => {
    const { sql } = buildRetentionQuery({
      ...base,
      firstEventFilters: [f('country', ['US'])],
      secondEventFilters: [f('os', ['iOS'])],
    });
    const { cohort, lastEvent } = ctes(sql);
    expect(cohort).toContain("country = 'US'");
    expect(cohort).not.toContain('os =');
    expect(lastEvent).toContain("os = 'iOS'");
    expect(lastEvent).not.toContain('country =');
  });

  it('drops profile./has_profile/cohort filters (unresolvable in the event WHERE)', () => {
    const { sql } = buildRetentionQuery({
      ...base,
      firstEventFilters: [
        f('profile.country', ['US']),
        f('has_profile', ['true']),
        f('x', [], 'inCohort', { cohortId: 'co-123' }),
      ],
    });
    const { cohort } = ctes(sql);
    expect(cohort).not.toContain('profile.country');
    expect(cohort).not.toContain('has_profile');
    expect(cohort).not.toContain('co-123');
  });

  it('criteria on_or_after => cumulative (>=), on => exact (=)', () => {
    expect(
      buildRetentionQuery({ ...base, criteria: 'on_or_after' }).sql,
    ).toContain('x_after_cohort >= 0');
    expect(buildRetentionQuery({ ...base, criteria: 'on' }).sql).toContain(
      'x_after_cohort = 0',
    );
  });

  it('escapes event names and supports multiple names via IN', () => {
    const { sql } = buildRetentionQuery({
      ...base,
      firstEvent: ['showOpen', 'reelOpen'],
    });
    expect(ctes(sql).cohort).toContain("name IN ('showOpen','reelOpen')");
  });
});

describe('processRetentionData', () => {
  it('returns [] for empty input', () => {
    expect(processRetentionData([], 2)).toEqual([]);
  });

  it('shapes per-cohort rows + a leading weighted-average row', () => {
    const rows = processRetentionData(
      [
        {
          cohort_interval: '2026-09-01',
          total_first_event_count: 100,
          interval_0_user_count: 100,
          interval_1_user_count: 50,
          interval_2_user_count: 25,
        },
      ],
      2,
    );
    // weighted-average row first, then the one cohort row
    expect(rows).toHaveLength(2);
    expect(rows[0]!.cohort_interval).toBe('Weighted Average');
    const cohort = rows[1]!;
    expect(cohort.sum).toBe(100);
    expect(cohort.values).toEqual([100, 50, 25]);
    expect(cohort.percentages).toEqual([1, 0.5, 0.25]);
  });
});
