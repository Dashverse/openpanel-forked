import { round } from '@openpanel/common';
import type { IChartEventFilter } from '@openpanel/validation';
import {
  differenceInDays,
  differenceInMonths,
  differenceInWeeks,
  formatISO,
} from 'date-fns';
import { range } from 'ramda';
import sqlstring from 'sqlstring';

import {
  TABLE_NAMES,
  aliasResolutionNeedsCte,
  chMcp,
  chQuery,
  getEventsTableForRange,
  resolvedPersonIdSql,
} from '../clickhouse/client';
import { getEventFiltersWhereClause } from './chart.service';

type IGetWeekRetentionInput = {
  projectId: string;
};

// https://www.geeksforgeeks.org/how-to-calculate-retention-rate-in-sql/
export function getRetentionCohortTable({ projectId }: IGetWeekRetentionInput) {
  const sql = `
WITH
  m AS
  (
      SELECT
          profile_id,
          max(toWeek(created_at)) AS last_seen
      FROM ${TABLE_NAMES.events}
      WHERE (project_id = ${sqlstring.escape(projectId)}) AND (profile_id != device_id)
      GROUP BY profile_id
  ),
  n AS
  (
      SELECT
          profile_id,
          min(toWeek(created_at)) AS first_seen
      FROM ${TABLE_NAMES.events}
      WHERE (project_id = ${sqlstring.escape(projectId)}) AND (profile_id != device_id)
      GROUP BY profile_id
  ),
  a AS
  (
      SELECT
          m.profile_id,
          m.last_seen,
          n.first_seen,
          m.last_seen - n.first_seen AS diff
      FROM m, n
      WHERE m.profile_id = n.profile_id
  )
SELECT
  first_seen,
  SUM(multiIf(diff = 0, 1, 0)) AS period_0,
  SUM(multiIf(diff = 1, 1, 0)) AS period_1,
  SUM(multiIf(diff = 2, 1, 0)) AS period_2,
  SUM(multiIf(diff = 3, 1, 0)) AS period_3,
  SUM(multiIf(diff = 4, 1, 0)) AS period_4,
  SUM(multiIf(diff = 5, 1, 0)) AS period_5,
  SUM(multiIf(diff = 6, 1, 0)) AS period_6,
  SUM(multiIf(diff = 7, 1, 0)) AS period_7,
  SUM(multiIf(diff = 8, 1, 0)) AS period_8,
  SUM(multiIf(diff = 9, 1, 0)) AS period_9
FROM a
GROUP BY first_seen
ORDER BY first_seen ASC
  `;

  return chQuery<{
    first_seen: number;
    period_0: number;
    period_1: number;
    period_2: number;
    period_3: number;
    period_4: number;
    period_5: number;
    period_6: number;
    period_7: number;
    period_8: number;
    period_9: number;
  }>(sql);
}

// Retention graph
// https://www.sisense.com/blog/how-to-calculate-cohort-retention-in-sql/
export function getRetentionSeries({ projectId }: IGetWeekRetentionInput) {
  const sql = `
    SELECT
      toStartOfWeek(events.created_at) AS date,
      countDistinct(events.profile_id) AS active_users,
      countDistinct(future_events.profile_id) AS retained_users,
      (100 * (countDistinct(future_events.profile_id) / CAST(countDistinct(events.profile_id), 'float'))) AS retention
    FROM ${TABLE_NAMES.events} as events
    LEFT JOIN ${TABLE_NAMES.events} AS future_events ON
      events.profile_id = future_events.profile_id
      AND toStartOfWeek(events.created_at) = toStartOfWeek(future_events.created_at - toIntervalWeek(1))
      AND future_events.profile_id != future_events.device_id
    WHERE
      project_id = ${sqlstring.escape(projectId)}
      AND events.profile_id != events.device_id
    GROUP BY 1
    ORDER BY date ASC`;

  return chQuery<{
    date: string;
    active_users: number;
    retained_users: number;
    retention: number;
  }>(sql);
}

// https://medium.com/@andre_bodro/how-to-fast-calculating-mau-in-clickhouse-fd793559b229
// Rolling active users
export type IServiceRetentionRollingActiveUsers = {
  date: string;
  users: number;
};
export function getRollingActiveUsers({
  projectId,
  days,
}: IGetWeekRetentionInput & { days: number }) {
  const sql = `
    SELECT
      date,
      uniqMerge(profile_id) AS users
    FROM
    (
      SELECT
          date + n AS date,
          profile_id,
          project_id
      FROM
      (
          SELECT *
          FROM ${TABLE_NAMES.dau_mv}
          WHERE project_id = ${sqlstring.escape(projectId)}
      )
      ARRAY JOIN range(${days}) AS n
    )
    WHERE project_id = ${sqlstring.escape(projectId)}
    GROUP BY date`;

  return chQuery<IServiceRetentionRollingActiveUsers>(sql);
}

export function getRetentionLastSeenSeries({
  projectId,
}: IGetWeekRetentionInput) {
  const sql = `
    WITH last_active AS (
        SELECT
            max(created_at) AS last_active,
            profile_id
        FROM ${TABLE_NAMES.events}
        WHERE (project_id = ${sqlstring.escape(projectId)}) AND (device_id != profile_id)
        GROUP BY profile_id
    )
    SELECT
      dateDiff('day', last_active, today()) AS days,
      countDistinct(profile_id) AS users
    FROM last_active
    GROUP BY days
    ORDER BY days ASC`;

  return chQuery<{
    days: number;
    users: number;
  }>(sql);
}

// ---------------------------------------------------------------------------
// Cohort retention matrix (the dashboard's "Retention" report / chart.cohort)
// ---------------------------------------------------------------------------

export type RetentionInterval = 'minute' | 'hour' | 'day' | 'week' | 'month';
export type RetentionCriteria = 'on_or_after' | 'on';

export interface RetentionQueryInput {
  projectId: string;
  /** Cohort-defining ("first") event names — a user enters the cohort in the
   *  interval they first fired any of these. */
  firstEvent: string[];
  /** Return ("second") event names — retention is measured by these firing in
   *  later intervals. */
  secondEvent: string[];
  criteria: RetentionCriteria;
  interval: RetentionInterval;
  /** Absolute window start (already timezone-resolved by the caller). */
  startDate: string;
  /** Absolute window end (already timezone-resolved by the caller). */
  endDate: string;
  /** A single global filter applied to BOTH the cohort-defining ("first") event
   *  and the return ("second") event. */
  filters?: IChartEventFilter[];
}

function utc(date: string | Date) {
  if (typeof date === 'string') {
    return date.replace('T', ' ').slice(0, 19);
  }
  return formatISO(date).replace('T', ' ').slice(0, 19);
}

/**
 * Build the retention (cohort) ClickHouse query and the interval span it covers.
 *
 * This is the SINGLE source of truth shared by the dashboard's `chart.cohort`
 * tRPC procedure and the MCP `get_retention` tool, so the two can never drift
 * into reporting different retention numbers.
 *
 * Retention reads raw `events` (routed to `events_v2` when enabled) instead of
 * the anon-excluding `cohort_events_mv`, and resolves each event to its
 * canonical person so a user's anonymous + identified activity — and logins
 * across devices — collapse to one (see #479). With the alias dictionary off
 * (self-hosted / dev) it falls back to the raw `profile_id`: still
 * anon-inclusive, just without cross-device identity stitching.
 */
export function buildRetentionQuery(input: RetentionQueryInput): {
  sql: string;
  diffInterval: number;
} {
  const { projectId, firstEvent, secondEvent, criteria, interval } = input;
  const startDate = input.startDate;
  const endDate = input.endDate;

  const diffInterval = {
    minute: () => differenceInDays(endDate, startDate),
    hour: () => differenceInDays(endDate, startDate),
    day: () => differenceInDays(endDate, startDate),
    week: () => differenceInWeeks(endDate, startDate),
    month: () => differenceInMonths(endDate, startDate),
  }[interval]();

  const sqlInterval = {
    minute: 'DAY',
    hour: 'DAY',
    day: 'DAY',
    week: 'WEEK',
    month: 'MONTH',
  }[interval];

  const sqlToStartOf = {
    minute: 'toDate',
    hour: 'toDate',
    day: 'toDate',
    week: 'toStartOfWeek',
    month: 'toStartOfMonth',
  }[interval];

  const countCriteria = criteria === 'on_or_after' ? '>=' : '=';

  const usersSelect = range(0, diffInterval + 1)
    .map(
      (index) =>
        `groupUniqArrayIf(profile_id, x_after_cohort ${countCriteria} ${index}) AS interval_${index}_users`,
    )
    .join(',\n');

  const countsSelect = range(0, diffInterval + 1)
    .map(
      (index) =>
        `length(interval_${index}_users) AS interval_${index}_user_count`,
    )
    .join(',\n');

  const whereEventNameIs = (event: string[]) => {
    if (event.length === 1) {
      return `name = ${sqlstring.escape(event[0])}`;
    }
    return `name IN (${event.map((e) => sqlstring.escape(e)).join(',')})`;
  };

  // Property filters applied to BOTH events (single global filter). Profile-scoped
  // and cohort filters are dropped here (the event WHERE can't resolve them);
  // mirrors the safe pattern in funnel.service.ts. When empty, `filterSql` is ''
  // so the generated SQL stays byte-identical to the no-filter case.
  const filterConditions = Object.values(
    getEventFiltersWhereClause(
      (input.filters ?? []).filter(
        (f) =>
          !f.name.startsWith('profile.') &&
          f.name !== 'has_profile' &&
          f.operator !== 'inCohort' &&
          f.operator !== 'notInCohort',
      ),
      projectId,
    ),
  );
  const filterSql = filterConditions.length
    ? `\n        ${filterConditions.map((c) => `AND (${c})`).join('\n        ')}`
    : '';

  // Columns are table-qualified so the resolved expression's inner `profile_id`
  // binds to the column, not the `AS profile_id` output alias (avoids
  // NOT_AN_AGGREGATE / ambiguous identifier — the #432 trap).
  const eventsTable = getEventsTableForRange(utc(startDate));
  const personSql = aliasResolutionNeedsCte()
    ? `${eventsTable}.profile_id`
    : resolvedPersonIdSql(
        projectId,
        `${eventsTable}.device_id`,
        `${eventsTable}.profile_id`,
      );

  const sql = `
    WITH
    cohort_users AS (
      SELECT
        ${personSql} AS userID,
        project_id,
        ${sqlToStartOf}(created_at) AS cohort_interval
      FROM ${eventsTable}
      WHERE ${whereEventNameIs(firstEvent)}
        AND project_id = ${sqlstring.escape(projectId)}
        AND created_at BETWEEN toDate('${utc(startDate)}') AND toDate('${utc(endDate)}')${filterSql}
    ),
    last_event AS
    (
        SELECT
            ${personSql} AS profile_id,
            project_id,
            toDate(created_at) AS event_date
        FROM ${eventsTable}
        WHERE ${whereEventNameIs(secondEvent)}
        AND project_id = ${sqlstring.escape(projectId)}
        AND created_at BETWEEN toDate('${utc(startDate)}') AND toDate('${utc(endDate)}') + INTERVAL ${diffInterval} ${sqlInterval}${filterSql}
    ),
    retention_matrix AS
    (
      SELECT
          f.cohort_interval,
          l.profile_id,
          dateDiff('${sqlInterval}', f.cohort_interval, ${sqlToStartOf}(l.event_date)) AS x_after_cohort
      FROM cohort_users AS f
      INNER JOIN last_event AS l ON f.userID = l.profile_id
      WHERE (l.event_date >= f.cohort_interval)
      AND (l.event_date <= (f.cohort_interval + INTERVAL ${diffInterval} ${sqlInterval}))
    ),
    interval_users AS (
      SELECT
        cohort_interval,
        ${usersSelect}
      FROM retention_matrix
      GROUP BY cohort_interval
    ),
    cohort_sizes AS (
      SELECT
        cohort_interval,
        COUNT(DISTINCT userID) AS total_first_event_count
      FROM cohort_users
      GROUP BY cohort_interval
    )
    SELECT
      interval_users.cohort_interval,
      cs.total_first_event_count,
      ${countsSelect}
    FROM interval_users
    LEFT JOIN cohort_sizes AS cs ON interval_users.cohort_interval = cs.cohort_interval
    ORDER BY interval_users.cohort_interval ASC
  `;

  return { sql, diffInterval };
}

export interface RetentionRow {
  cohort_interval: string;
  sum: number;
  values: number[];
  percentages: number[];
}

/**
 * Collapse the raw per-interval ClickHouse rows into per-cohort retention rows
 * plus a leading weighted-average row (weighted by cohort size, zeros excluded)
 * — the exact shape the dashboard's cohort chart consumes.
 */
export function processRetentionData(
  data: Array<{
    cohort_interval: string;
    total_first_event_count: number;
    [key: string]: any;
  }>,
  diffInterval: number,
): RetentionRow[] {
  if (data.length === 0) {
    return [];
  }

  const processed = data.map((row) => {
    const sum = row.total_first_event_count;
    const values = range(0, diffInterval + 1).map(
      (index) => (row[`interval_${index}_user_count`] || 0) as number,
    );

    return {
      cohort_interval: row.cohort_interval,
      sum,
      values,
      percentages: values.map((value) => (sum > 0 ? round(value / sum, 2) : 0)),
    };
  });

  const averageData: {
    totalSum: number;
    values: Array<{ sum: number; weightedSum: number }>;
    percentages: Array<{ sum: number; weightedSum: number }>;
  } = {
    totalSum: 0,
    values: range(0, diffInterval + 1).map(() => ({ sum: 0, weightedSum: 0 })),
    percentages: range(0, diffInterval + 1).map(() => ({
      sum: 0,
      weightedSum: 0,
    })),
  };

  // Aggregate data for weighted averages, excluding zeros
  processed.forEach((row) => {
    averageData.totalSum += row.sum;
    row.values.forEach((value, index) => {
      if (value !== 0) {
        averageData.values[index]!.sum += row.sum;
        averageData.values[index]!.weightedSum += value * row.sum;
      }
    });
    row.percentages.forEach((percentage, index) => {
      if (percentage !== 0) {
        averageData.percentages[index]!.sum += row.sum;
        averageData.percentages[index]!.weightedSum += percentage * row.sum;
      }
    });
  });

  // Calculate weighted average values, excluding zeros
  const averageRow = {
    cohort_interval: 'Weighted Average',
    sum: round(averageData.totalSum / processed.length, 0),
    percentages: averageData.percentages.map(({ sum, weightedSum }) =>
      sum > 0 ? round(weightedSum / sum, 2) : 0,
    ),
    values: averageData.values.map(({ sum, weightedSum }) =>
      sum > 0 ? round(weightedSum / sum, 0) : 0,
    ),
  };

  return [averageRow, ...processed];
}

/**
 * Headless retention core for the MCP layer. Runs the shared retention query on
 * `chMcp` (read-only user, execution-time capped) over an absolute date window
 * and returns the same per-cohort matrix the dashboard renders, plus the labels
 * the caller needs to interpret each column ("interval N after cohort start").
 */
export async function getRetentionCore(input: {
  projectId: string;
  firstEvent: string[];
  secondEvent: string[];
  startDate: string;
  endDate: string;
  criteria?: RetentionCriteria;
  interval?: RetentionInterval;
  /** A single global filter applied to BOTH events. */
  filters?: Array<{
    name: string;
    operator: IChartEventFilter['operator'];
    value?: (string | number | boolean | null)[];
  }>;
}) {
  const criteria = input.criteria ?? 'on_or_after';
  const interval = input.interval ?? 'day';

  const filters: IChartEventFilter[] = (input.filters ?? []).map(
    (f, index) => ({
      id: String(index),
      name: f.name,
      operator: f.operator,
      value: f.value ?? [],
    }),
  );

  const { sql, diffInterval } = buildRetentionQuery({
    projectId: input.projectId,
    firstEvent: input.firstEvent,
    secondEvent: input.secondEvent,
    criteria,
    interval,
    startDate: input.startDate,
    endDate: input.endDate,
    filters,
  });

  const res = await chMcp.query({ query: sql, format: 'JSONEachRow' });
  const rows = await res.json<{
    cohort_interval: string;
    total_first_event_count: number;
    [key: string]: any;
  }>();

  const cohorts = processRetentionData(
    rows.map((r) => ({
      ...r,
      total_first_event_count: Number(r.total_first_event_count),
    })),
    diffInterval,
  );

  return {
    firstEvent: input.firstEvent,
    secondEvent: input.secondEvent,
    criteria,
    interval,
    startDate: input.startDate,
    endDate: input.endDate,
    // Number of "interval N after cohort start" columns in each row's
    // values/percentages arrays (index 0 = the cohort interval itself).
    intervalsTracked: diffInterval + 1,
    // First row is the size-weighted average across all cohorts; the rest are
    // one row per cohort interval (oldest first). `values` are user counts,
    // `percentages` are those counts over the cohort's first-event size.
    cohorts,
  };
}
