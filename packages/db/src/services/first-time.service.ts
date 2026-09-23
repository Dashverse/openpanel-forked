import sqlstring from 'sqlstring';

import type { IChartEvent } from '@openpanel/validation';

import {
  TABLE_NAMES,
  aliasResolutionNeedsCte,
  formatClickhouseDate,
  resolvedPersonIdSql,
} from '../clickhouse/client';

/**
 * "First time for user" (all-time first) — shared query fragment.
 *
 * Semantics (LOCKED): global-first-that-matches (PostHog's default). A user
 * counts iff their FIRST-EVER occurrence of the event (across ALL history, not
 * just the selected range) falls inside the range AND satisfies the event's
 * property filters. This is NOT "first-among-filtered".
 *
 * The helper emits a single-pass GROUP-BY-per-person subquery:
 *
 *   SELECT argMinIf(profile_id, created_at, <inRange+filters>) AS winner_pid,
 *          minIf(created_at, <inRange+filters>)                AS first_in_range
 *   FROM <events v1> e [LEFT JOIN alias map]
 *   WHERE project_id = <pid> AND name = <evt> AND created_at <= <endDate>
 *   GROUP BY <resolved person>
 *   HAVING min(created_at) = first_in_range AND min(created_at) != toDateTime(0)
 *
 * CRITICAL invariants (see PostHog FirstTimeForUserEventsQueryAlternator):
 *  - `min(created_at)` / the HAVING equality run on RAW UTC `created_at` with NO
 *    start bound (only `created_at <= endDate`). Never timezone-shift before the
 *    min — a day-boundary shift can flip which event is "first". Callers bucket
 *    only the surviving row (via the outer query's toStartOf*(.., timezone)).
 *  - Event property filters go into the `minIf`/`argMinIf` conditional leg (the
 *    `first_in_range` computation), NOT into the outer WHERE and NOT into the
 *    base `min`. That is what makes it "global-first-that-matches".
 *  - "person" = the canonical person (resolvedPersonIdSql) so an anon device's
 *    first event and the same user's post-login events collapse to one subject.
 *    dict on -> dictGet (no join); dict off -> inline profile_aliases join.
 *  - Reads the v1 `events` table for the historical `min` (events_v2 is
 *    incomplete before its cutoff and cannot serve an all-time min).
 *
 * The output is a set of `(winner_pid, first_in_range)` pairs — the raw
 * profile_id and timestamp of each surviving person's global-first matching
 * event. Callers gate the real event rows with:
 *
 *   (profile_id, created_at) IN (<this subquery>)
 *
 * which restricts a chart/funnel/conversion scan to exactly those first-time
 * rows, composing with the existing filter / breakdown / segment machinery.
 * Resolving identity inside the subquery (and matching back on the raw
 * `profile_id`) means the caller does NOT need its own alias join/dictGet on the
 * outer scan.
 *
 * On-the-fly only: no materialized view, no row-count guardrail. Giant events
 * (e.g. 1.5B rows) may be slow — acceptable for Phase 1.
 */
export function buildFirstTimeSubquery({
  projectId,
  eventName,
  startDate,
  endDate,
  filterConditions = [],
  table = TABLE_NAMES.events,
  alias = 'e',
}: {
  projectId: string;
  eventName: string;
  startDate: string;
  endDate: string;
  /**
   * Event-level property filter fragments (raw SQL, e.g. from
   * `getEventFiltersWhereClause`). Only pass EVENT filters — not profile.* /
   * cohort filters, which reference joins the subquery does not have. They go
   * into the `minIf`/`argMinIf` conditional leg. Fragments may reference the
   * events table via the `alias` (default `e`) or unqualified column names.
   */
  filterConditions?: string[];
  /** Historical table for the all-time min. Defaults to v1 `events`. */
  table?: string;
  /** Alias for the events table inside the subquery (default `e`). */
  alias?: string;
}): string {
  const startTs = `toDateTime('${formatClickhouseDate(startDate)}')`;
  const endTs = `toDateTime('${formatClickhouseDate(endDate)}')`;

  const person = resolvedPersonIdSql(
    projectId,
    `${alias}.device_id`,
    `${alias}.profile_id`,
  );

  // dict off -> inline the alias map as a joined subquery (NOT a CTE, so this
  // fragment can be embedded inside another query's IN() without CTE-reference
  // restrictions). dict on -> resolvedPersonIdSql is a pure dictGet expression
  // and no join is needed.
  const aliasJoin = aliasResolutionNeedsCte()
    ? `
        LEFT JOIN (
          SELECT alias, argMax(profile_id, created_at) AS canonical
          FROM ${TABLE_NAMES.alias}
          WHERE project_id = ${sqlstring.escape(projectId)}
          GROUP BY alias
        ) al ON al.alias = ${alias}.device_id`
    : '';

  // The in-range + event-filter leg. Start bound + property filters live ONLY
  // here (never in the base min / outer WHERE) — global-first-that-matches.
  const inRangeCond = [`created_at >= ${startTs}`, ...filterConditions]
    .map((c) => `(${c})`)
    .join(' AND ');

  return `SELECT
        argMinIf(${alias}.profile_id, created_at, ${inRangeCond}) AS winner_pid,
        minIf(created_at, ${inRangeCond}) AS first_in_range
      FROM ${table} AS ${alias}${aliasJoin}
      WHERE project_id = ${sqlstring.escape(projectId)}
        AND name = ${sqlstring.escape(eventName)}
        AND created_at <= ${endTs}
      GROUP BY ${person}
      HAVING min(created_at) = first_in_range AND min(created_at) != toDateTime(0)`;
}

/**
 * Whether a first-time event can be served on the CURRENT chart/funnel/
 * conversion path. Phase 1 supports the common trend / breakdown / per-user
 * cases; the unqualified `(profile_id, created_at) IN (...)` gate is ambiguous
 * once a cohort join (which also carries a `profile_id`) is on the same scan, so
 * cohort combinations are deferred and fall through to the non-first-time path.
 */
export function isFirstTime(event: Pick<IChartEvent, 'firstTime'>): boolean {
  return event.firstTime === true;
}
