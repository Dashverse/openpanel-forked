import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getChartSql } from './chart.service';

/**
 * Deterministic tests for getChartSql's first-time-for-user handling. We only
 * assert on the generated SQL string — getChartSql builds SQL synchronously and
 * (for the cases here: no cohorts, no custom events, no profile filters) makes
 * no ClickHouse / Postgres calls.
 */

const PROJECT = 'proj_chart';

// Slice out the injected first-time subquery so we can assert on it in
// isolation (from the first argMinIf to the closing HAVING of the subquery).
const subquerySlice = (sql: string): string => {
  const start = sql.indexOf('argMinIf');
  const end = sql.indexOf('!= toDateTime(0)', start);
  return start === -1 ? '' : sql.slice(start, end);
};

const baseInput = (overrides: Record<string, unknown> = {}) =>
  ({
    event: {
      id: 'A',
      name: 'signup',
      segment: 'event',
      filters: [],
    },
    breakdowns: [],
    interval: 'day',
    startDate: '2024-01-01 00:00:00',
    endDate: '2024-01-31 00:00:00',
    projectId: PROJECT,
    timezone: 'UTC',
    chartType: 'linear',
    metric: 'sum',
    previous: false,
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture bypasses full IGetChartDataInput
  }) as any;

describe('getChartSql — first time for user', () => {
  const priorDict = process.env.PROFILE_ALIAS_DICT;

  beforeEach(() => {
    process.env.PROFILE_ALIAS_DICT = ''; // dict OFF (deterministic al-CTE path)
  });

  afterEach(() => {
    if (priorDict === undefined) {
      // biome-ignore lint/performance/noDelete: restore pristine env
      delete process.env.PROFILE_ALIAS_DICT;
    } else {
      process.env.PROFILE_ALIAS_DICT = priorDict;
    }
  });

  it('injects the first-time IN (<subquery>) gate for segment=event and skips the MV', async () => {
    const sql = await getChartSql(
      baseInput({
        event: {
          id: 'A',
          name: 'signup',
          segment: 'event',
          filters: [],
          firstTime: true,
        },
      }),
    );

    expect(sql).toContain('(e.profile_id, e.created_at) IN (');
    expect(sql).toContain('argMinIf(e.profile_id, created_at,');
    // MUST NOT use the pre-aggregated daily-stats MV (it has no per-user
    // first-occurrence concept and would silently return full totals).
    expect(sql).not.toContain('events_daily_stats');
  });

  it('injects the first-time gate for segment=user too (unique-visitor count)', async () => {
    const sql = await getChartSql(
      baseInput({
        event: {
          id: 'A',
          name: 'signup',
          segment: 'user',
          filters: [],
          firstTime: true,
        },
      }),
    );

    expect(sql).toContain('uniq(e.profile_id) as count');
    expect(sql).toContain('(e.profile_id, e.created_at) IN (');
    expect(sql).toContain('argMinIf(e.profile_id, created_at,');
    // SINGLE-EXECUTION: the expensive first-time subquery must appear EXACTLY
    // once (only the main query's IN gate). The old separate total_unique CTE
    // re-ran it a second time; the first-time denominator is now derived from
    // the same gated scan via a windowed aggregate.
    expect(subquerySlice(sql)).not.toBe('');
    expect(sql.split('argMinIf(e.profile_id, created_at,').length - 1).toBe(1);
    // No second re-scan CTE gated on the raw table name.
    expect(sql).not.toContain('(events.profile_id, events.created_at) IN (');
    // First-time-scoped denominator via a window over the single gated scan.
    expect(sql).toContain(
      'uniqMerge(uniqState(e.profile_id)) OVER () as total_count',
    );
    expect(sql).not.toContain('events_daily_stats');
  });

  it('does NOT inject a first-time subquery when firstTime is false/absent, and the MV fast path is allowed', async () => {
    const withFalse = await getChartSql(
      baseInput({
        event: {
          id: 'A',
          name: 'signup',
          segment: 'event',
          filters: [],
          firstTime: false,
        },
      }),
    );
    expect(withFalse).not.toContain('argMinIf');
    // No filters + day interval + event segment → MV fast path is taken.
    expect(withFalse).toContain('events_daily_stats');

    const absent = await getChartSql(baseInput());
    expect(absent).not.toContain('argMinIf');
    expect(absent).toContain('events_daily_stats');
  });

  it('routes an event property filter into the minIf leg of the subquery', async () => {
    const sql = await getChartSql(
      baseInput({
        event: {
          id: 'A',
          name: 'signup',
          segment: 'event',
          firstTime: true,
          filters: [
            {
              id: 'f1',
              name: 'properties.plan',
              operator: 'is',
              value: ['pro'],
            },
          ],
        },
      }),
    );

    const sub = subquerySlice(sql);
    expect(sub).not.toBe('');
    // The property filter is applied inside the conditional leg (global-first-
    // that-matches), so it appears within the subquery region.
    expect(sub).toContain("properties['plan']");
    // And it also still constrains the outer scan (appears more than once total).
    expect(sql.split("properties['plan']").length - 1).toBeGreaterThan(1);
  });

  it('buckets with the timezone but takes the all-time min on raw (UTC) created_at', async () => {
    const sql = await getChartSql(
      baseInput({
        interval: 'month',
        timezone: 'America/New_York',
        event: {
          id: 'A',
          name: 'signup',
          segment: 'event',
          filters: [],
          firstTime: true,
        },
      }),
    );

    // Outer bucketing is timezone-aware.
    expect(sql).toContain("toStartOfMonth(created_at, 'America/New_York')");
    // The first-time subquery must NEVER timezone-shift before the min — a
    // day-boundary shift could flip which event is "first".
    const sub = subquerySlice(sql);
    expect(sub).not.toContain('America/New_York');
    expect(sql).toContain('min(created_at) = first_in_range');
  });
});
