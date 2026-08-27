import { uniq } from 'ramda';
import sqlstring from 'sqlstring';

import { DateTime, stripLeadingAndTrailingSlashes } from '@openpanel/common';
import type {
  CohortDefinition,
  IChartEvent,
  IChartEventFilter,
  IChartInput,
  IChartRange,
  ICustomEventDefinition,
  IGetChartDataInput,
} from '@openpanel/validation';

import { db } from '../../index';
import {
  TABLE_NAMES,
  aliasResolutionNeedsCte,
  formatClickhouseDate,
  getEventsTableForRange,
  getPropertyMvTableForRange,
  resolvedProfileIdSql,
} from '../clickhouse/client';
import { createSqlBuilder } from '../sql-builder';
import {
  buildEventCriteriaQuery,
  buildPropertyBasedCohortQuery,
} from './cohort.service';
import {
  expandCustomEventToSQL,
  getCustomEventByName,
} from './custom-event.service';

// Cache for materialized columns mapping
let materializedColumnsCache: Record<string, string> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function filterByTargetTable(
  cache: Record<string, string>,
  targetTable?: 'events' | 'profiles',
): Record<string, string> {
  if (!targetTable) return cache;
  return Object.fromEntries(
    Object.entries(cache).filter(([key]) =>
      targetTable === 'profiles'
        ? key.startsWith('profile.properties.')
        : key.startsWith('properties.'),
    ),
  );
}

/**
 * Get materialized columns from database with caching.
 * Pass targetTable to get only columns for that table:
 *   'events'   → keys starting with "properties.*"
 *   'profiles' → keys starting with "profile.properties.*"
 *   (omit)     → all columns (used by getSelectPropertyKey)
 */
export async function getMaterializedColumns(
  targetTable?: 'events' | 'profiles',
): Promise<Record<string, string>> {
  const now = Date.now();

  // Return cached value if still valid
  if (materializedColumnsCache && now - cacheTimestamp < CACHE_TTL) {
    return filterByTargetTable(materializedColumnsCache, targetTable);
  }

  try {
    const columns = await db.materializedColumn.findMany({
      where: { status: 'active' },
      select: { propertyKey: true, columnName: true, targetTable: true },
    });

    const mapping: Record<string, string> = {};
    for (const col of columns) {
      const quotedColName = `\`${col.columnName}\``;
      if (col.targetTable === 'profiles') {
        // e.g. "profile.properties.campaign" -> "profile.`campaign`"
        mapping[`profile.properties.${col.propertyKey}`] =
          `profile.${quotedColName}`;
      } else {
        // e.g. "properties.utm_source" -> "`utm_source`"
        mapping[`properties.${col.propertyKey}`] = quotedColName;
      }
    }

    materializedColumnsCache = mapping;
    cacheTimestamp = now;
    return filterByTargetTable(mapping, targetTable);
  } catch (error) {
    // If database query fails, return empty mapping (fallback to properties['key'])
    console.warn('Failed to load materialized columns:', error);
    return {};
  }
}

/**
 * Initialize materialized columns cache (call at startup)
 */
export async function initMaterializedColumnsCache(): Promise<void> {
  await getMaterializedColumns();
}

/**
 * Refresh materialized columns cache (call after adding new columns)
 */
export async function refreshMaterializedColumnsCache(): Promise<void> {
  materializedColumnsCache = null;
  cacheTimestamp = 0;
  await getMaterializedColumns();
}

// Initialize cache on module load (lazy)
getMaterializedColumns().catch(() => {
  // Ignore errors on initial load
});

// Cohort metadata type
type CohortMetadata = {
  id: string;
  name: string;
  computeOnDemand: boolean;
  definition: CohortDefinition;
};

/**
 * Fetch metadata for multiple cohorts from Postgres (no cache - always fresh)
 */
export async function fetchCohortsMetadata(
  cohortIds: string[],
): Promise<Map<string, CohortMetadata>> {
  if (cohortIds.length === 0) {
    return new Map();
  }

  // Fetch all cohorts in one query
  const cohorts = await db.cohort.findMany({
    where: { id: { in: cohortIds } },
    select: { id: true, name: true, computeOnDemand: true, definition: true },
  });

  return new Map(
    cohorts.map((c) => [
      c.id,
      {
        id: c.id,
        name: c.name,
        computeOnDemand: c.computeOnDemand,
        definition: c.definition as CohortDefinition,
      },
    ]),
  );
}

/**
 * Generate cohort membership query for CTE
 * Returns the full SELECT query
 */
export function buildCohortMembershipQuery(
  cohortId: string,
  projectId: string,
  cohortMeta?: CohortMetadata,
  profileIdPrefilter?: string,
  // Emit CANONICAL person ids so the cohort JOINs onto an identity-resolved
  // funnel/chart/conversion in the same identity space. Only takes effect when
  // the alias dict is loaded (self-contained dictGet); otherwise raw ids, which
  // matches the un-resolved group the caller falls back to when the dict is off.
  resolveIdentity = false,
): string {
  const resolve = resolveIdentity && !aliasResolutionNeedsCte();

  // Pre-computed cohorts or missing metadata: read from stored membership.
  // cohort_members has no device_id, so resolve the stored profile_id itself.
  if (!cohortMeta || !cohortMeta.computeOnDemand) {
    // Qualify the raw column so the coalesce can't bind to the `AS profile_id`
    // output alias (see cohort.service eventsPid).
    const cmPid = `${TABLE_NAMES.cohort_members}.profile_id`;
    const prefilterClause = profileIdPrefilter
      ? `AND ${resolve ? cmPid : 'profile_id'} IN (${profileIdPrefilter})`
      : '';
    const pid = resolve
      ? `${resolvedProfileIdSql(projectId, cmPid)} AS profile_id`
      : 'profile_id';
    return `
      SELECT ${pid}
      FROM ${TABLE_NAMES.cohort_members} FINAL
      WHERE cohort_id = ${sqlstring.escape(cohortId)}
        AND project_id = ${sqlstring.escape(projectId)}
        ${prefilterClause}
    `;
  }

  // Dynamic cohorts: build query from definition
  const definition = cohortMeta.definition;

  if (definition.type === 'event') {
    const { events, operator } = definition.criteria;
    const queries = events.map((eventCriteria) =>
      buildEventCriteriaQuery(
        projectId,
        eventCriteria,
        profileIdPrefilter,
        resolveIdentity,
      ),
    );

    return operator === 'and'
      ? queries.join(' INTERSECT ')
      : queries.join(' UNION DISTINCT ');
  } else if (definition.type === 'property') {
    return buildPropertyBasedCohortQuery(
      projectId,
      definition,
      profileIdPrefilter,
      resolveIdentity,
    );
  }

  throw new Error(`Unknown cohort type: ${(definition as any).type}`);
}

/**
 * Get CTE name for a cohort (quoted with backticks)
 */
export function getCohortCteName(cohortId: string): string {
  return `\`cohort-${cohortId}\``;
}

/**
 * Get table alias for a cohort (used in JOINs)
 */
export function getCohortAlias(cohortId: string): string {
  return `cohort_${cohortId.replace(/-/g, '_')}`;
}

/**
 * Build inline cohort JOIN clause with subquery
 * Used in CTEs where CTE references are not allowed by ClickHouse
 */
function buildInlineCohortJoin(
  cohortId: string,
  projectId: string,
  tableAlias: string,
  cohortMeta?: CohortMetadata,
): string {
  const cohortAlias = getCohortAlias(cohortId);
  const cohortQuery = buildCohortMembershipQuery(
    cohortId,
    projectId,
    cohortMeta,
  );
  return `LEFT ANY JOIN (${cohortQuery}) AS ${cohortAlias} ON ${cohortAlias}.profile_id = ${tableAlias}.profile_id`;
}

export function transformPropertyKey(property: string) {
  const propertyPatterns = ['properties', 'profile.properties'];
  const match = propertyPatterns.find((pattern) =>
    property.startsWith(`${pattern}.`),
  );

  if (!match) {
    return property;
  }

  if (property.includes('*')) {
    return property
      .replace(/^properties\./, '')
      .replace('.*.', '.%.')
      .replace(/\[\*\]$/, '.%')
      .replace(/\[\*\].?/, '.%.');
  }

  return `${match}['${property.replace(new RegExp(`^${match}.`), '')}']`;
}

export function getSelectPropertyKey(
  property: string,
  projectId?: string,
  cohortId?: string,
  cohortName?: string,
) {
  // Handle cohort breakdown
  // Use cohortId parameter if provided, otherwise parse from property name (backwards compatibility)
  const extractedCohortId =
    cohortId ||
    (property.startsWith('cohort:') ? property.split(':')[1] : null);

  if (extractedCohortId && projectId) {
    // Use JOIN-based approach instead of IN subquery for better performance
    const cohortAlias = getCohortAlias(extractedCohortId);
    const inLabel = cohortName ? sqlstring.escape(cohortName) : "'In Cohort'";
    const notInLabel = cohortName
      ? sqlstring.escape(`Not ${cohortName}`)
      : "'Not In Cohort'";
    // Use notEmpty() to handle both join_use_nulls=0 (returns '') and join_use_nulls=1 (returns NULL)
    // When join_use_nulls=0, ClickHouse returns empty string for unmatched LEFT JOIN rows instead of NULL
    // notEmpty() correctly identifies both cases as "Not In Cohort"
    return `if(
      notEmpty(${cohortAlias}.profile_id),
      ${inLabel},
      ${notInLabel}
    )`;
  }

  if (property === 'has_profile') {
    return `if(e.profile_id != e.device_id, 'true', 'false')`;
  }

  // Handle profile.created_at - it's stored as created_at in the profiles table
  if (property === 'profile.created_at') {
    return 'profile.created_at';
  }

  const propertyPatterns = ['properties', 'profile.properties'];

  const match = propertyPatterns.find((pattern) =>
    property.startsWith(`${pattern}.`),
  );
  if (!match) return property;

  // Use materialized columns from cache if available
  if (materializedColumnsCache && materializedColumnsCache[property]) {
    return materializedColumnsCache[property]!;
  }

  if (property.includes('*')) {
    return `arrayMap(x -> trim(x), mapValues(mapExtractKeyLike(${match}, ${sqlstring.escape(
      transformPropertyKey(property),
    )})))`;
  }

  // For profile.properties.X without a materialized column, reference the
  // aliased extracted column the profile JOIN must add (e.g. `properties.X`)
  // instead of `profile.properties['X']`. The JOIN selecting the whole
  // `properties` Map collides with `events.properties` whenever a funnel /
  // conversion mixes a profile.* filter with an event-level properties.*
  // filter — CH throws "ambiguous identifier 'properties'". Pairing this
  // with the aliased SELECT in funnel/conversion services removes the
  // collision by construction.
  if (match === 'profile.properties') {
    const key = property.replace('profile.properties.', '');
    return `profile.\`properties.${key}\``;
  }

  return `${match}['${property.replace(new RegExp(`^${match}.`), '')}']`;
}

function getChartSqlFromMaterializedView({
  event,
  interval,
  startDate,
  endDate,
  projectId,
  timezone,
}: {
  event: IGetChartDataInput['event'];
  interval: IGetChartDataInput['interval'];
  startDate: string;
  endDate: string;
  projectId: string;
  timezone: string;
}): string {
  const { sb, getSelect, getWhere, getGroupBy, getOrderBy, getFill } =
    createSqlBuilder();

  // Use materialized view table with alias to avoid column name conflicts
  sb.from = 'events_daily_stats t';

  // Base filters (use table alias)
  sb.where.projectId = `t.project_id = ${sqlstring.escape(projectId)}`;
  if (event.name !== '*') {
    sb.where.eventName = `t.name = ${sqlstring.escape(event.name)}`;
  }
  sb.where.dateRange = `t.date >= toDate(${sqlstring.escape(startDate)}) AND t.date <= toDate(${sqlstring.escape(endDate)})`;

  // Label
  if (event.name !== '*') {
    sb.select.label_0 = `${sqlstring.escape(event.name)} as label_0`;
  } else {
    sb.select.label_0 = `'*' as label_0`;
  }

  // Count based on segment (use table alias)
  if (event.segment === 'user') {
    sb.select.count = 'uniqMerge(t.unique_profiles_state) as count';
  } else if (event.segment === 'session') {
    sb.select.count = 'uniqMerge(t.unique_sessions_state) as count';
  } else {
    sb.select.count = 'countMerge(t.event_count) as count';
  }

  // Date aggregation based on interval (use table alias)
  // Use DateTime format to match the regular query output (toStartOfDay returns DateTime).
  // This prevents date-format mismatches when mixing MV series with non-MV series
  // (e.g. one series has filters → regular query returns "2026-02-24 00:00:00",
  //  another has no filters → MV query previously returned bare "2026-02-24").
  if (interval === 'day') {
    sb.select.date = 'toStartOfDay(toDateTime(t.date)) as date';
    sb.groupBy.date = 'toStartOfDay(toDateTime(t.date))';
    sb.orderBy.date = 'toStartOfDay(toDateTime(t.date)) ASC';
  } else if (interval === 'week') {
    sb.select.date = 'toDateTime(toStartOfWeek(t.date, 1)) as date';
    sb.groupBy.date = 'toDateTime(toStartOfWeek(t.date, 1))';
    sb.orderBy.date = 'toDateTime(toStartOfWeek(t.date, 1)) ASC';
  } else if (interval === 'month') {
    sb.select.date = 'toDateTime(toStartOfMonth(t.date)) as date';
    sb.groupBy.date = 'toDateTime(toStartOfMonth(t.date))';
    sb.orderBy.date = 'toDateTime(toStartOfMonth(t.date)) ASC';
  }

  // Build WITH FILL for date gaps — use DateTime to match the regular query fill format
  let fillClause = '';
  if (interval === 'day') {
    fillClause = `WITH FILL FROM toStartOfDay(toDateTime(${sqlstring.escape(startDate)})) TO toStartOfDay(toDateTime(${sqlstring.escape(endDate)})) STEP toIntervalDay(1)`;
  } else if (interval === 'week') {
    fillClause = `WITH FILL FROM toDateTime(toStartOfWeek(toDate(${sqlstring.escape(startDate)}), 1)) TO toDateTime(toStartOfWeek(toDate(${sqlstring.escape(endDate)}), 1)) STEP toIntervalWeek(1)`;
  } else if (interval === 'month') {
    fillClause = `WITH FILL FROM toDateTime(toStartOfMonth(toDate(${sqlstring.escape(startDate)}))) TO toDateTime(toStartOfMonth(toDate(${sqlstring.escape(endDate)}))) STEP toIntervalMonth(1)`;
  }

  const sql = `${getSelect()} FROM ${sb.from} ${getWhere()} ${getGroupBy()} ${getOrderBy()} ${fillClause}`;

  console.log('-- Using Materialized View --');
  console.log(sql.replaceAll(/[\n\r]/g, ' '));
  console.log('-- End --');

  return sql;
}

function canUseMaterializedView(
  event: IGetChartDataInput['event'],
  breakdowns: IGetChartDataInput['breakdowns'],
  interval: IGetChartDataInput['interval'],
): boolean {
  // Can use MV if:
  // 1. Interval is day or larger (not hour/minute)
  // 2. No breakdowns OR single breakdown with no filters
  // 3. Segment is 'user' or 'session' or 'event'
  // 4. No complex property filters
  // 5. No cohort breakdowns
  const validIntervals = ['day', 'week', 'month'];
  const validSegments = ['user', 'session', 'event'];

  const hasCohortBreakdown = breakdowns.some((b) =>
    b.name.startsWith('cohort:'),
  );
  if (hasCohortBreakdown) {
    return false;
  }

  return (
    validIntervals.includes(interval) &&
    validSegments.includes(event.segment ?? 'event') &&
    breakdowns.length === 0 &&
    (!event.filters || event.filters.length === 0) &&
    event.segment !== 'one_event_per_user'
  );
}

// profile_event_property_summary_mv retention window. The MV keeps ~last
// 3 months of data (verified 2026-07-07: 202603 = 424 MiB near-empty,
// 202604 onward = TiB-range fully-populated). Compute the floor as a
// rolling cutoff rather than hardcoding a date — the gate stays correct
// as the retention window slides forward, no re-deploy needed.
//
// Cutoff is returned as `YYYY-MM-DD` (10 chars). Callers must compare the
// date portion only — comparing full DateTime strings would reject a
// dashboard-emitted `2026-04-07 00:00:00` against a same-day cutoff whose
// time-of-day is later (`2026-04-07 21:XX:XX`). Bug caught on 2026-07-07
// prod smoke test.
//
// Using 92 days (~3 months + a couple-day safety margin) so the "3m"
// dashboard preset always fits: user picks range=3m → startDate = today
// - 90d, and 92 > 90 so the gate accepts. Bump if the preset widens.
function getPropertyMVCutoffDate(): string {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 92);
  return formatClickhouseDate(cutoff).slice(0, 10);
}

// Project safety allowlist. Both MVs the router uses filter
// `profile_id != device_id` on write, so anonymous events are excluded.
// The identified/anonymous split is PROJECT-SPECIFIC:
//   dashreels showOpen  → 99.8% identified (MV is complete)
//   shortreels showOpen → 15.7% identified (MV misses 84% of events)
// Routing a shortreels filtered/breakdown chart through the MV would
// silently under-count by ~6x, so this route is gated on an explicit
// allowlist. Unknown projects fail closed to the events-table path.
//
// To onboard a new project, verify its identify rate on the top events
// used in filtered/breakdown charts (see diagnostic SQL in
// docs/conversion-chart-perf.md) and add the project_id here.
const MV_ROUTING_ALLOWED_PROJECTS = new Set<string>(['dashreels']);

// Extract property key from filter.name for MV routing.
// Dashboard filters on event properties come through as 'properties.<key>'.
// A filter targeting a bare materialized column (name = '<key>' with no
// 'properties.' prefix) is out of scope for this router — that path already
// goes through the events table with skip index / projection pruning
// (measured 8s for 30-day country='US' — acceptable, doesn't need MV routing).
function extractEventPropertyKey(filterName: string): string | null {
  if (filterName.startsWith('properties.')) {
    return filterName.slice('properties.'.length);
  }
  return null;
}

// Gate for routing to profile_event_property_summary_mv (sort key
// `(project_id, name, property_key, property_value, profile_id, event_date)`
// — extreme prefix selectivity for event-scoped property filters).
//
// Prod measurement (2026-07-07, dashreels 30-day logIn + type='truecaller'):
//   events table (no skip idx on `type`): 52.4s, 6.68 B rows, 152 GiB
//   this MV route:                         0.38s,  1.4 M rows, 128 MiB
//   → ~140x speedup with matching numbers.
//
// Intentionally conservative for MVP:
//   - ONE event-level property filter (multi-property AND works too via
//     INNER JOIN of matching CTEs at ~0.4s — deferred to follow-up)
//   - operator = 'is' only (list values via 'is' with multi-value array is OK
//     since MV supports `property_value IN (...)` cheaply via prefix scan)
//   - No breakdowns (property breakdowns would need JOIN with sibling MV rows;
//     name/cohort breakdowns are best handled elsewhere)
//   - Segment: 'user' or 'event' (MV has profile_id + countState; no
//     session-uniq state → session segment falls through)
//   - Date range start >= rolling 3-month cutoff (MV retention window)
//   - Event name is explicit (MV sort key needs the name; '*' can't prefix-scan)
//
// MV filter (`profile_id != device_id`): only identified-user events are
// stored. For events like logIn / purchase / subscribeStart / etc. this is
// 100% coverage; for anonymous-heavy events this MV would under-count and
// the caller must NOT route here. In practice event-property-filter charts
// on the dashboard are on identified events; if we hit a false positive we
// widen the gate.
function canUsePropertyMV(
  event: IGetChartDataInput['event'],
  breakdowns: IGetChartDataInput['breakdowns'],
  interval: IGetChartDataInput['interval'],
  startDate: string,
  projectId: string,
): boolean {
  if (!MV_ROUTING_ALLOWED_PROJECTS.has(projectId)) return false;

  // The property-MV fast-path reads the v2 MV (property_key/property_value
  // schema), which only covers PROPERTY_MV_V2_MIN_DATE (Jul 1) forward. The v1
  // property MV is RETIRED (anon-excluding). So for ranges before the v2 window
  // — or when the env is unset — skip this fast-path and let the regular
  // events-table path serve the property filter/breakdown (anon-inclusive,
  // correct). Never route to the retired v1 MV.
  const v2MinDate = process.env.PROPERTY_MV_V2_MIN_DATE?.trim();
  if (!v2MinDate || String(startDate) < v2MinDate) return false;

  const validIntervals = ['day', 'week', 'month'];
  if (!validIntervals.includes(interval)) return false;

  const validSegments = ['user', 'event'];
  if (!validSegments.includes(event.segment ?? 'event')) return false;

  if (event.name === '*') return false;

  const hasCohortFilter = event.filters?.some(
    (f) =>
      f.operator === 'inCohort' ||
      f.operator === 'notInCohort' ||
      !!f.cohortId,
  );
  if (hasCohortFilter) return false;

  const filters = event.filters ?? [];
  const numFilters = filters.length;
  const numBreakdowns = breakdowns.length;

  // Filter XOR breakdown, each at most one property. Combined
  // (filter AND breakdown) needs an intersection JOIN of two MV rows for
  // the same event — deferred to the multi-property PR. Zero of both
  // means the events_daily_stats route handles it (no reason to be here).
  if (numFilters + numBreakdowns !== 1) return false;

  if (numFilters === 1) {
    const f = filters[0]!;
    if (f.operator !== 'is') return false;
    if (!f.value || f.value.length === 0) return false;
    if (!extractEventPropertyKey(f.name)) return false;
  } else {
    const b = breakdowns[0]!;
    // Cohort breakdowns need cohort membership joins, not this MV
    if (b.cohortId || b.name.startsWith('cohort:')) return false;
    if (!extractEventPropertyKey(b.name)) return false;
  }

  // Date-only comparison. startDate is a DateTime string like
  // '2026-04-07 00:00:00'; slice off the time so a same-day cutoff
  // doesn't reject the query on hour-of-day.
  //
  // When v2 property-MV routing is ON (PROPERTY_MV_V2_MIN_DATE set), the
  // effective cutoff is the v2 window start: only ranges v2 covers use the MV
  // (getChartSqlFromPropertyMV then reads the anon-correct v2 table). Ranges
  // before it return false and fall through to the events_v2/events path
  // (correct) instead of the undercounting v1 MV. Env unset = legacy v1-retention
  // cutoff, unchanged.
  const v2Cutoff = process.env.PROPERTY_MV_V2_MIN_DATE?.trim();
  const cutoff = v2Cutoff ? v2Cutoff.slice(0, 10) : getPropertyMVCutoffDate();
  if (startDate.slice(0, 10) < cutoff) return false;

  return true;
}

function getChartSqlFromPropertyMV({
  event,
  breakdowns,
  interval,
  startDate,
  endDate,
  projectId,
  limit,
}: {
  event: IGetChartDataInput['event'];
  breakdowns: IGetChartDataInput['breakdowns'];
  interval: IGetChartDataInput['interval'];
  startDate: string;
  endDate: string;
  projectId: string;
  timezone: string;
  limit?: number;
}): string {
  // Gate guarantees XOR(filter, breakdown): exactly one is present.
  // Both bind the same property_key on the MV; filter pins property_value,
  // breakdown returns it as the label_1 aggregation dimension.
  const filter = event.filters?.[0];
  const breakdown = breakdowns[0];
  const isBreakdown = !filter && !!breakdown;

  const propKey = isBreakdown
    ? extractEventPropertyKey(breakdown!.name)!
    : extractEventPropertyKey(filter!.name)!;

  // Filter mode only — breakdown returns all values.
  // Trim before escape to match the sibling MV builder in cohort.service.ts
  // (which trims the same values before writing to
  // profile_event_property_summary_mv scans). Without matching normalization,
  // an incidental trailing space in a dashboard value would silently miss
  // rows via this route while the cohort path would still find them.
  const valueList = isBreakdown
    ? ''
    : filter!.value!.map((v) => sqlstring.escape(String(v).trim())).join(', ');

  const dateSelect =
    interval === 'day'
      ? 'toStartOfDay(toDateTime(t.event_date)) as date'
      : interval === 'week'
        ? 'toDateTime(toStartOfWeek(t.event_date, 1)) as date'
        : 'toDateTime(toStartOfMonth(t.event_date)) as date';
  const dateGroupBy =
    interval === 'day'
      ? 'toStartOfDay(toDateTime(t.event_date))'
      : interval === 'week'
        ? 'toDateTime(toStartOfWeek(t.event_date, 1))'
        : 'toDateTime(toStartOfMonth(t.event_date))';

  // User segment: distinct profile_id across matching (profile, date) rows.
  // uniqExact is accurate; the MV holds one row per (project, profile, name,
  // key, value, day) so cardinality is bounded and the exact aggregate is
  // cheap.
  // Event segment: countMerge on the AggregateFunction(count) column.
  const countExpr =
    event.segment === 'user'
      ? 'uniqExact(t.profile_id) as count'
      : 'countMerge(t.event_count) as count';

  const fillClause =
    interval === 'day'
      ? `WITH FILL FROM toStartOfDay(toDateTime(${sqlstring.escape(startDate)})) TO toStartOfDay(toDateTime(${sqlstring.escape(endDate)})) STEP toIntervalDay(1)`
      : interval === 'week'
        ? `WITH FILL FROM toDateTime(toStartOfWeek(toDate(${sqlstring.escape(startDate)}), 1)) TO toDateTime(toStartOfWeek(toDate(${sqlstring.escape(endDate)}), 1)) STEP toIntervalWeek(1)`
        : `WITH FILL FROM toDateTime(toStartOfMonth(toDate(${sqlstring.escape(startDate)}))) TO toDateTime(toStartOfMonth(toDate(${sqlstring.escape(endDate)}))) STEP toIntervalMonth(1)`;

  // Breakdown mode emits property_value AS label_1; groups by (label_1, date) so
  // each series is one property_value. Note MV is populated with
  // `property_value != ''` — events with an empty value for the breakdown
  // key are absent from the MV under this key, so the breakdown result
  // omits the "no-value" bucket. Events-table path would show it as a
  // '' bucket. Dashboards typically want distinct-value buckets, so this
  // is desirable more often than not.
  const breakdownSelect = isBreakdown ? '\n      t.property_value AS label_1,' : '';
  const breakdownGroupBy = isBreakdown ? 'label_1, ' : '';
  const valueClause = isBreakdown
    ? ''
    : `\n      AND t.property_value IN (${valueList})`;

  // ORDER BY / WITH FILL layout:
  // - Filter mode: single-column sort (date). Fill clause at the end.
  // - Breakdown mode: sort by (label_1, date) and apply WITH FILL to the
  //   trailing date column. This produces per-series fill — each
  //   distinct label_1 value gets its own contiguous timeline. Putting
  //   date first with WITH FILL and label_1 as a secondary key would
  //   fill the date column globally and leave gap-days without a
  //   label_1, breaking per-series semantics in the frontend.
  const orderByClause = isBreakdown
    ? `ORDER BY label_1 ASC, ${dateGroupBy} ASC ${fillClause}`
    : `ORDER BY ${dateGroupBy} ASC\n    ${fillClause}`;

  // Breakdown mode: cap to the top-N property values by the same metric,
  // mirroring the events path's `top_breakdowns LIMIT`. Without this the MV
  // returns EVERY distinct value (76k+ for high-card props like `reason`), and
  // the per-series WITH FILL multiplies that by the interval count — 610k+ rows
  // to the client, which overflows the formatter's `Math.max(...spread)`. The
  // frontend only renders the top `limit` series anyway, so this is result-
  // equivalent, just bounded.
  // Route to the anon-inclusive v2 property MV when the range starts >= the
  // Jul-1 cutoff; otherwise v1 (which has full history). Same schema, so only
  // the table name changes.
  const propTable = getPropertyMvTableForRange(startDate);

  const rankExpr =
    event.segment === 'user'
      ? 'uniqExact(t.profile_id)'
      : 'countMerge(t.event_count)';
  const topValuesCte =
    isBreakdown && limit
      ? `WITH top_values AS (
      SELECT t.property_value
      FROM ${propTable} t
      WHERE t.project_id = ${sqlstring.escape(projectId)}
        AND t.name = ${sqlstring.escape(event.name)}
        AND t.property_key = ${sqlstring.escape(propKey)}
        AND t.event_date >= toDateTime(${sqlstring.escape(startDate)})
        AND t.event_date <= toDateTime(${sqlstring.escape(endDate)})
      GROUP BY t.property_value
      ORDER BY ${rankExpr} DESC
      LIMIT ${Math.floor(limit)}
    )
    `
      : '';
  const breakdownLimitClause =
    isBreakdown && limit
      ? '\n      AND t.property_value IN (SELECT property_value FROM top_values)'
      : '';

  const sql = `${topValuesCte}SELECT
      ${sqlstring.escape(event.name)} as label_0,${breakdownSelect}
      ${countExpr},
      ${dateSelect}
    FROM ${propTable} t
    WHERE t.project_id = ${sqlstring.escape(projectId)}
      AND t.name = ${sqlstring.escape(event.name)}
      AND t.property_key = ${sqlstring.escape(propKey)}${valueClause}${breakdownLimitClause}
      AND t.event_date >= toDateTime(${sqlstring.escape(startDate)})
      AND t.event_date <= toDateTime(${sqlstring.escape(endDate)})
    GROUP BY ${breakdownGroupBy}${dateGroupBy}
    ${orderByClause}`;

  return sql;
}

/**
 * Build the inner (per-user) aggregation expression.
 * Reduces all of a single user's events to one value.
 */
function getPerUserInnerAggExpr(
  perUser: NonNullable<IChartEvent['perUser']>,
  projectId: string,
): string {
  const agg = perUser.aggregation;
  if (agg === 'count' || !perUser.property) {
    return 'count(*)';
  }

  const propertyKey = getSelectPropertyKey(perUser.property, projectId);

  // distinct_count counts distinct raw property values (no numeric cast)
  if (agg === 'distinct_count') {
    return `uniq(${propertyKey})`;
  }

  const numericExpr = isNumericColumn(perUser.property)
    ? propertyKey
    : `toFloat64OrNull(${propertyKey})`;

  switch (agg) {
    case 'sum':
      return `sum(${numericExpr})`;
    case 'avg':
      return `avg(${numericExpr})`;
    case 'min':
      return `min(${numericExpr})`;
    case 'max':
      return `max(${numericExpr})`;
    case 'median':
      return `quantile(0.5)(${numericExpr})`;
    case 'p90':
      return `quantile(0.9)(${numericExpr})`;
    case 'p95':
      return `quantile(0.95)(${numericExpr})`;
    case 'p99':
      return `quantile(0.99)(${numericExpr})`;
    default:
      return 'count(*)';
  }
}

/**
 * Build the outer (across-user) aggregation, applied to the per-user values
 * in the SUMMARY view. Driven by the event `segment`.
 */
function getPerUserOuterAggExpr(
  segment: IGetChartDataInput['event']['segment'],
  column: string,
): string {
  switch (segment) {
    case 'property_sum':
      return `sum(${column})`;
    case 'property_min':
      return `min(${column})`;
    case 'property_max':
      return `max(${column})`;
    case 'property_median':
      return `quantile(0.5)(${column})`;
    case 'property_p90':
      return `quantile(0.9)(${column})`;
    case 'property_p95':
      return `quantile(0.95)(${column})`;
    case 'property_p99':
      return `quantile(0.99)(${column})`;
    case 'property_distinct':
      return `uniq(${column})`;
    // property_average, user_average and anything else default to the mean
    // across users — the most common "per-user" summary.
    default:
      return `avg(${column})`;
  }
}

/**
 * Per-user (two-level) computed-metric SQL.
 *
 * Reduces each user to one value (inner aggregation), then either:
 *  - SUMMARY: aggregates those values across users into a time series, or
 *  - DISTRIBUTION (chartType==='distribution'): buckets users by their value.
 *
 * The result rows match the standard `{label_0, [label_1], date, count}` shape
 * so the rest of the engine (fetch -> groupByLabels -> format -> tRPC) is
 * reused unchanged. For the DISTRIBUTION view the bucket label is carried in
 * the opaque `date` column.
 *
 * v1 scope: single breakdown dimension, event-level filters/breakdowns only
 * (cohort/profile breakdowns are not supported on this path).
 */
function getPerUserChartSql({
  event,
  breakdowns,
  interval,
  startDate,
  endDate,
  projectId,
  timezone,
  chartType,
}: IGetChartDataInput & { timezone: string }): string {
  const perUser = event.perUser!;
  const isDistribution = chartType === 'distribution';
  // The inner aggregation falls back to count(*) whenever no property is set
  // (e.g. a property-based aggregation chosen before picking the property).
  const effectiveAggregation =
    perUser.aggregation === 'count' || !perUser.property
      ? 'count'
      : perUser.aggregation;
  // count() and distinct_count produce integer-valued per-user metrics → use
  // discrete buckets; everything else is continuous → equal-width bins.
  const isDiscrete =
    effectiveAggregation === 'count' ||
    effectiveAggregation === 'distinct_count';

  // WHERE clause (event filters + project + name + date range)
  const where = getEventFiltersWhereClause(event.filters ?? [], projectId);
  where.projectId = `project_id = ${sqlstring.escape(projectId)}`;
  if (event.name !== '*') {
    where.eventName = `name = ${sqlstring.escape(event.name)}`;
  }
  if (startDate) {
    where.startDate = `created_at >= toDateTime('${formatClickhouseDate(startDate)}')`;
  }
  if (endDate) {
    where.endDate = `created_at <= toDateTime('${formatClickhouseDate(endDate)}')`;
  }
  const whereClause = Object.keys(where).length
    ? `WHERE ${Object.values(where).join(' AND ')}`
    : '';

  const innerAgg = getPerUserInnerAggExpr(perUser, projectId);

  // Single breakdown (v1). Cohort/profile breakdowns are skipped on this path.
  const breakdown = breakdowns?.find(
    (b) =>
      !b.cohortId &&
      !b.name.startsWith('cohort:') &&
      !b.name.startsWith('profile.'),
  );
  const breakdownKey = breakdown
    ? getSelectPropertyKey(breakdown.name, projectId)
    : null;

  const label0 =
    event.name !== '*'
      ? `${sqlstring.escape(event.name)} as label_0`
      : `'*' as label_0`;
  const label1Select = breakdownKey ? `, bk as label_1` : '';
  const label1Group = breakdownKey ? `, label_1` : '';
  const bkInnerSelect = breakdownKey ? `, ${breakdownKey} as bk` : '';
  const bkInnerGroup = breakdownKey ? `, bk` : '';

  if (isDistribution) {
    // Bucket users by their per-user value.
    const perUserCte = `SELECT profile_id${bkInnerSelect}, ${innerAgg} as user_value
      FROM ${getEventsTableForRange(startDate)} e
      ${whereClause}
      GROUP BY profile_id${bkInnerGroup}`;

    let bucketExpr: string;
    let fromClause: string;
    if (isDiscrete) {
      bucketExpr = `multiIf(user_value = 1, '1', user_value = 2, '2', user_value = 3, '3', user_value <= 5, '4-5', user_value <= 10, '6-10', '10+')`;
      fromClause = `(${perUserCte}) as per_user`;
    } else {
      // Equal-width bins using global min/max (10 bins). Label = bin lower bound.
      bucketExpr = `if(
        stats.mx = stats.mn,
        toString(round(stats.mn, 2)),
        toString(round(stats.mn + least(toUInt32(floor((user_value - stats.mn) / ((stats.mx - stats.mn) / 10))), 9) * ((stats.mx - stats.mn) / 10), 2))
      )`;
      fromClause = `(${perUserCte}) as per_user
        CROSS JOIN (SELECT min(user_value) as mn, max(user_value) as mx FROM (${perUserCte})) as stats`;
    }

    const sql = `SELECT
      ${label0},
      ${bucketExpr} as date${label1Select},
      count(*) as count,
      min(user_value) as bucket_order
    FROM ${fromClause}
    WHERE user_value IS NOT NULL
    GROUP BY date${label1Group}
    ORDER BY bucket_order ASC`;

    console.log('-- Per-user Distribution --');
    console.log(sql.replaceAll(/[\n\r]/g, ' '));
    console.log('-- End --');
    return sql;
  }

  // SUMMARY view: per-user value per interval, then aggregate across users.
  const outerAgg = getPerUserOuterAggExpr(event.segment, 'user_value');

  let dateExpr: string;
  let fill: string;
  switch (interval) {
    case 'minute':
      dateExpr = `toStartOfMinute(created_at)`;
      fill = `WITH FILL FROM toStartOfMinute(toDateTime('${startDate}')) TO toStartOfMinute(toDateTime('${endDate}')) STEP toIntervalMinute(1)`;
      break;
    case 'hour':
      dateExpr = `toStartOfHour(created_at)`;
      fill = `WITH FILL FROM toStartOfHour(toDateTime('${startDate}')) TO toStartOfHour(toDateTime('${endDate}')) STEP toIntervalHour(1)`;
      break;
    case 'week':
      dateExpr = `toStartOfWeek(created_at, 1, '${timezone}')`;
      fill = `WITH FILL FROM toStartOfWeek(toDateTime('${startDate}'), 1, '${timezone}') TO toStartOfWeek(toDateTime('${endDate}'), 1, '${timezone}') STEP toIntervalWeek(1)`;
      break;
    case 'month':
      dateExpr = `toStartOfMonth(created_at, '${timezone}')`;
      fill = `WITH FILL FROM toStartOfMonth(toDateTime('${startDate}'), '${timezone}') TO toStartOfMonth(toDateTime('${endDate}'), '${timezone}') STEP toIntervalMonth(1)`;
      break;
    default:
      dateExpr = `toStartOfDay(created_at)`;
      fill = `WITH FILL FROM toStartOfDay(toDateTime('${startDate}')) TO toStartOfDay(toDateTime('${endDate}')) STEP toIntervalDay(1)`;
      break;
  }

  const perUserCte = `SELECT ${dateExpr} as date, profile_id${bkInnerSelect}, ${innerAgg} as user_value
    FROM ${getEventsTableForRange(startDate)} e
    ${whereClause}
    GROUP BY date, profile_id${bkInnerGroup}`;

  const sql = `SELECT
    ${label0},
    date${label1Select},
    ${outerAgg} as count
  FROM (${perUserCte}) as per_user
  WHERE user_value IS NOT NULL
  GROUP BY date${label1Group}
  ORDER BY date ASC ${fill}`;

  console.log('-- Per-user Summary --');
  console.log(sql.replaceAll(/[\n\r]/g, ' '));
  console.log('-- End --');
  return sql;
}

export async function getChartSql({
  event,
  breakdowns,
  interval,
  startDate,
  endDate,
  projectId,
  limit,
  timezone,
  chartType,
  customEvent,
  sortOrder,
}: IGetChartDataInput & {
  timezone: string;
  customEvent?: { name: string; definition: ICustomEventDefinition };
}) {
  // Per-user (two-level) computed metric: handled by a self-contained builder.
  // Also covers the `distribution` chart type (frequency / value distribution),
  // which implies a per-user metric — default to event-count frequency.
  if (event.perUser || chartType === 'distribution') {
    const perUserEvent: IChartEvent = event.perUser
      ? event
      : { ...event, perUser: { aggregation: 'count' } };
    return getPerUserChartSql({
      event: perUserEvent,
      breakdowns,
      interval,
      startDate,
      endDate,
      projectId,
      limit,
      timezone,
      chartType,
    } as IGetChartDataInput & { timezone: string });
  }
  // Pre-fetch cohort metadata for all cohorts used in this query (deduplicated)
  const cohortIdsSet = new Set<string>();

  // Extract cohort IDs from breakdowns
  breakdowns?.forEach((b) => {
    if (b.cohortId) {
      cohortIdsSet.add(b.cohortId);
    } else if (b.name.startsWith('cohort:')) {
      cohortIdsSet.add(b.name.split(':')[1]!);
    }
  });

  // Extract cohort IDs from event filters
  event.filters?.forEach((filter) => {
    if (filter.cohortId) {
      cohortIdsSet.add(filter.cohortId);
    }
  });

  const cohortIds = Array.from(cohortIdsSet);

  // Fetch cohort metadata from Postgres (always fresh, no cache)
  const cohortMetadata = await fetchCohortsMetadata(cohortIds);

  // Check if we can use materialized view for fast queries
  // Custom events cannot use materialized views (for now)
  if (!customEvent && canUseMaterializedView(event, breakdowns, interval)) {
    return getChartSqlFromMaterializedView({
      event,
      interval,
      startDate,
      endDate,
      projectId,
      timezone,
    });
  }

  // Second MV route — when the query has a single event-level property
  // filter (e.g. `type='truecaller'`) that events_daily_stats can't answer
  // because it lacks the property dimension. profile_event_property_summary_mv
  // has (project_id, name, property_key, property_value, ...) as sort-key
  // prefix — ~140x faster than the events-table skip-index scan (0.38s vs
  // 52.4s measured on dashreels 30-day logIn + type='truecaller').
  if (
    !customEvent &&
    canUsePropertyMV(event, breakdowns, interval, startDate, projectId)
  ) {
    return getChartSqlFromPropertyMV({
      event,
      breakdowns,
      interval,
      startDate,
      endDate,
      projectId,
      timezone,
      limit,
    });
  }

  const {
    sb,
    join,
    getWhere,
    getFrom,
    getJoins,
    getSelect,
    getOrderBy,
    getGroupBy,
    getFill,
    getWith,
    with: addCte,
  } = createSqlBuilder();

  // RETIRED: profile_event_summary_mv carries `profile_id != device_id`, so it is
  // anon-excluded and UNDERCOUNTS pre-login/anonymous users. Cohort-breakdown
  // trend counts now read events_v2 (anon-inclusive, correct) like every other
  // chart — see the no-wrong-data policy. Forced off so the MV can be dropped.
  const hasCohortBreakdown = breakdowns.some(
    (b) => b.name.startsWith('cohort:') || b.cohortId,
  );
  const allBreakdownsAreCohort = breakdowns.every(
    (b) => b.name.startsWith('cohort:') || b.cohortId,
  );
  const hasPropertyFilters = event.filters?.some(
    (f) => f.name.startsWith('properties.') || f.name.startsWith('profile.'),
  );
  const useCohortMV =
    false &&
    !customEvent &&
    hasCohortBreakdown &&
    allBreakdownsAreCohort &&
    !hasPropertyFilters &&
    ['day', 'week', 'month'].includes(interval) &&
    ['user', 'event', undefined].includes(event.segment ?? 'event') &&
    event.segment !== 'one_event_per_user';

  if (useCohortMV) {
    sb.from = `${TABLE_NAMES.profile_event_summary_mv} e`;
  } else {
    // Route the standard trend/breakdown main query to events_v2 when the range
    // qualifies. createSqlBuilder()'s default `from` is hardcoded `events e` (v1);
    // #404 routed the breakdown CTEs (getEventsTableForRange) but not this main
    // FROM, so breakdown/trend charts scanned the slow name-last v1 table while
    // their CTEs read v2. The custom-event and distinct paths reassign sb.from
    // below, so this only sets the default for the regular events path.
    sb.from = `${getEventsTableForRange(startDate)} e`;
  }

  // Create CTEs for all cohorts (used by main query only)
  // NOTE: ClickHouse allows CTEs to be referenced in the main query's JOINs,
  // but NOT in other CTEs' JOINs. For CTEs that need cohort data, we inline subqueries.
  cohortIds.forEach((cohortId) => {
    const cohortMeta = cohortMetadata.get(cohortId);
    const cohortQuery = buildCohortMembershipQuery(
      cohortId,
      projectId,
      cohortMeta,
    );
    addCte(getCohortCteName(cohortId), cohortQuery);
  });

  // Common setup
  sb.where = getEventFiltersWhereClause(event.filters, projectId);
  sb.where.projectId = `project_id = ${sqlstring.escape(projectId)}`;
  sb.select.label_0 =
    event.name !== '*'
      ? `${sqlstring.escape(event.name)} as label_0`
      : `'*' as label_0`;

  // Setup data source: custom event CTE or regular events table
  if (customEvent) {
    await setupCustomEventCTE(
      sb,
      addCte,
      customEvent,
      projectId,
      startDate,
      endDate,
    );
  } else if (event.name !== '*') {
    sb.where.eventName = `name = ${sqlstring.escape(event.name)}`;
  }

  const anyFilterOnProfile = event.filters.some((filter) =>
    filter.name.startsWith('profile.'),
  );
  const anyBreakdownOnProfile = breakdowns.some((breakdown) =>
    breakdown.name.startsWith('profile.'),
  );

  // Build WHERE clause without the bar filter (for use in subqueries and CTEs)
  // Define this early so we can use it in CTE definitions
  const getWhereWithoutBar = () => {
    const whereWithoutBar = { ...sb.where };
    delete whereWithoutBar.bar;
    return Object.keys(whereWithoutBar).length
      ? `WHERE ${join(whereWithoutBar, ' AND ')}`
      : '';
  };

  // Collect all profile fields used in filters and breakdowns
  // Extract top-level field names (e.g., 'properties' from 'profile.properties.os')
  // When a profile.properties.* key has a materialized column, select that column
  // directly instead of the whole properties map.
  const getProfileFields = () => {
    const fields = new Set<string>();

    // Always need id for the join
    fields.add('id');

    const allProfileNames = [
      ...event.filters
        .filter((f) => f.name.startsWith('profile.'))
        .map((f) => f.name),
      ...breakdowns
        .filter((b) => b.name.startsWith('profile.'))
        .map((b) => b.name),
    ];

    for (const propName of allProfileNames) {
      if (propName.startsWith('profile.properties.')) {
        // Check if there's a materialized column in the cache
        if (materializedColumnsCache && materializedColumnsCache[propName]) {
          // e.g. cache value is "profile.campaign" -> select "campaign"
          const colName = materializedColumnsCache[propName]!.replace(
            'profile.',
            '',
          );
          fields.add(colName);
        } else {
          // No materialized column: select the whole properties map
          fields.add('properties');
        }
      } else {
        // Direct profile field (email, first_name, etc.)
        const fieldName = propName.replace('profile.', '').split('.')[0];
        if (
          fieldName &&
          ['email', 'first_name', 'last_name', 'created_at'].includes(fieldName)
        ) {
          fields.add(fieldName);
        }
      }
    }

    return Array.from(fields);
  };

  // Create profiles CTE if profiles are needed (to avoid duplicating the heavy profile join)
  // Only select the fields that are actually used
  const profilesJoinRef =
    anyFilterOnProfile || anyBreakdownOnProfile
      ? 'LEFT ANY JOIN profile ON profile.id = e.profile_id'
      : '';

  // Profile JOIN for CTEs that don't use 'e' alias (use table name directly)
  const profilesJoinRefForCTE =
    anyFilterOnProfile || anyBreakdownOnProfile
      ? `LEFT ANY JOIN profile ON profile.id = ${getEventsTableForRange(startDate)}.profile_id`
      : '';

  if (anyFilterOnProfile || anyBreakdownOnProfile) {
    const profileFields = getProfileFields();
    const selectFields = profileFields.map((field) => {
      // Keep original column names without aliases
      // so they can be accessed as profile.properties, profile.email, etc.
      return field;
    });

    // Add profiles CTE using the builder
    addCte(
      'profile',
      `SELECT ${selectFields.join(', ')}
      FROM ${TABLE_NAMES.profiles} FINAL
      WHERE project_id = ${sqlstring.escape(projectId)}`,
    );

    // Use the CTE reference in the main query
    sb.joins.profiles = profilesJoinRef;
  }

  // Add LEFT JOINs for all cohorts (much faster than IN subqueries)
  cohortIds.forEach((cohortId) => {
    const cohortAlias = getCohortAlias(cohortId);
    const cohortCte = getCohortCteName(cohortId);
    sb.joins[`cohort_${cohortId}`] =
      `LEFT ANY JOIN ${cohortCte} AS ${cohortAlias} ON ${cohortAlias}.profile_id = e.profile_id`;
  });

  // When using cohort MV, swap column names and aggregate functions
  const countExpr = useCohortMV ? 'countMerge(e.event_count)' : 'count(*)';
  const dateExpr = useCohortMV ? 'toDateTime(e.event_date)' : 'created_at';

  sb.select.count = `${countExpr} as count`;

  switch (interval) {
    case 'minute': {
      sb.fill = `FROM toStartOfMinute(toDateTime('${startDate}')) TO toStartOfMinute(toDateTime('${endDate}')) STEP toIntervalMinute(1)`;
      sb.select.date = `toStartOfMinute(${dateExpr}) as date`;
      break;
    }
    case 'hour': {
      sb.fill = `FROM toStartOfHour(toDateTime('${startDate}')) TO toStartOfHour(toDateTime('${endDate}')) STEP toIntervalHour(1)`;
      sb.select.date = `toStartOfHour(${dateExpr}) as date`;
      break;
    }
    case 'day': {
      sb.fill = `FROM toStartOfDay(toDateTime('${startDate}')) TO toStartOfDay(toDateTime('${endDate}')) STEP toIntervalDay(1)`;
      sb.select.date = `toStartOfDay(${dateExpr}) as date`;
      break;
    }
    case 'week': {
      sb.fill = `FROM toStartOfWeek(toDateTime('${startDate}'), 1, '${timezone}') TO toStartOfWeek(toDateTime('${endDate}'), 1, '${timezone}') STEP toIntervalWeek(1)`;
      sb.select.date = `toStartOfWeek(${dateExpr}, 1, '${timezone}') as date`;
      break;
    }
    case 'month': {
      sb.fill = `FROM toStartOfMonth(toDateTime('${startDate}'), '${timezone}') TO toStartOfMonth(toDateTime('${endDate}'), '${timezone}') STEP toIntervalMonth(1)`;
      sb.select.date = `toStartOfMonth(${dateExpr}, '${timezone}') as date`;
      break;
    }
  }
  sb.groupBy.date = 'date';
  sb.orderBy.date = 'date ASC';

  if (startDate) {
    sb.where.startDate = useCohortMV
      ? `event_date >= toDate('${formatClickhouseDate(startDate)}')`
      : `created_at >= toDateTime('${formatClickhouseDate(startDate)}')`;
  }

  if (endDate) {
    sb.where.endDate = useCohortMV
      ? `event_date <= toDate('${formatClickhouseDate(endDate)}')`
      : `created_at <= toDateTime('${formatClickhouseDate(endDate)}')`;
  }

  // Use CTE to define top breakdown values once, then reference in WHERE clause
  if (breakdowns.length > 0 && limit) {
    const breakdownSelects = breakdowns
      .map((b) =>
        getSelectPropertyKey(
          b.name,
          projectId,
          b.cohortId,
          b.cohortId ? cohortMetadata.get(b.cohortId)?.name : undefined,
        ),
      )
      .join(', ');

    // Build cohort JOINs for top_breakdowns CTE
    // NOTE: ClickHouse CTEs cannot reference other CTEs in JOINs, so we inline the subquery
    const cohortJoinsForTop = cohortIds
      .map((cohortId) => {
        const cohortMeta = cohortMetadata.get(cohortId);
        return buildInlineCohortJoin(cohortId, projectId, 'e', cohortMeta);
      })
      .join(' ');

    // Determine data source: use cohort MV, custom event CTE, or regular events table
    const dataSource = useCohortMV
      ? TABLE_NAMES.profile_event_summary_mv
      : customEvent
        ? 'custom_event_data'
        : getEventsTableForRange(startDate);
    const orderByCount = useCohortMV ? 'countMerge(e.event_count)' : 'count(*)';

    // Add top_breakdowns CTE using the builder
    addCte(
      'top_breakdowns',
      `SELECT ${breakdownSelects}
      FROM ${dataSource} AS e
      ${profilesJoinRef ? `${profilesJoinRef} ` : ''}${cohortJoinsForTop ? `${cohortJoinsForTop} ` : ''}${getWhereWithoutBar()}
      GROUP BY ${breakdownSelects}
      ORDER BY ${orderByCount} ${sortOrder === 'asc' ? 'ASC' : 'DESC'}
      LIMIT ${limit}`,
    );

    // Filter main query to only include top breakdown values
    const barSelects = breakdowns
      .map((b) =>
        getSelectPropertyKey(
          b.name,
          projectId,
          b.cohortId,
          b.cohortId ? cohortMetadata.get(b.cohortId)?.name : undefined,
        ),
      )
      .join(',');
    sb.where.bar = `(${barSelects}) IN (SELECT * FROM top_breakdowns)`;
  }

  breakdowns.forEach((breakdown, index) => {
    // Breakdowns start at label_1 (label_0 is reserved for event name)
    const key = `label_${index + 1}`;
    const selectKey = getSelectPropertyKey(
      breakdown.name,
      projectId,
      breakdown.cohortId,
      breakdown.cohortId
        ? cohortMetadata.get(breakdown.cohortId)?.name
        : undefined,
    );
    sb.select[key] = `${selectKey} as ${key}`;
    sb.groupBy[key] = `${key}`;
  });

  if (event.segment === 'user') {
    sb.select.count = 'uniq(e.profile_id) as count';
  }

  if (event.segment === 'session') {
    sb.select.count = 'uniq(e.session_id) as count';
  }

  if (event.segment === 'user_average') {
    sb.select.count =
      'COUNT(*)::float / COUNT(DISTINCT e.profile_id)::float as count';
  }

  const mathFunction = {
    property_sum: 'sum',
    property_average: 'avg',
    property_max: 'max',
    property_min: 'min',
  }[event.segment as string];

  if (mathFunction && event.property) {
    const propertyKey = getSelectPropertyKey(event.property, projectId);

    if (isNumericColumn(event.property)) {
      sb.select.count = `${mathFunction}(${propertyKey}) as count`;
      sb.where.property = `${propertyKey} IS NOT NULL`;
    } else {
      sb.select.count = `${mathFunction}(toFloat64OrNull(${propertyKey})) as count`;
      sb.where.property = `${propertyKey} IS NOT NULL AND notEmpty(${propertyKey})`;
    }
  }

  if (event.segment === 'one_event_per_user') {
    // `SELECT *` omits MATERIALIZED columns, so the outer query's filters or
    // breakdowns on a materialized column (e.g. `source`) fail inside this
    // subquery with "Unknown expression identifier `source`". Project the
    // materialized columns explicitly (same as the custom-event CTE path).
    // Exclude `name` — already provided by `*` — to avoid a duplicate column.
    const materializedColumns = await getMaterializedColumns('events');
    const materializedColumnNames = Object.values(materializedColumns).filter(
      (col) => col.replace(/`/g, '') !== 'name',
    );
    const materializedColumnsSelect =
      materializedColumnNames.length > 0
        ? `, ${materializedColumnNames.join(', ')}`
        : '';
    sb.from = `(
      SELECT DISTINCT ON (profile_id) *${materializedColumnsSelect} from ${getEventsTableForRange(startDate)} ${getJoins()} WHERE ${join(
        sb.where,
        ' AND ',
      )}
        ORDER BY profile_id, created_at DESC
      ) as subQuery`;
    sb.joins = {};

    const sql = `${getWith()}${getSelect()} ${getFrom()} ${getJoins()} ${getWhere()} ${getGroupBy()} ${getOrderBy()} ${getFill()}`;
    console.log('-- Report --');
    console.log(sql.replaceAll(/[\n\r]/g, ' '));
    console.log('-- End --');
    return sql;
  }

  if (breakdowns.length > 0) {
    const breakdownSelects = breakdowns
      .map((b, index) => {
        const propertyKey = getSelectPropertyKey(
          b.name,
          projectId,
          b.cohortId,
          b.cohortId ? cohortMetadata.get(b.cohortId)?.name : undefined,
        );
        return `${propertyKey} as breakdown_${index + 1}`;
      })
      .join(', ');

    const breakdownGroupBy = breakdowns
      .map((b, index) => `breakdown_${index + 1}`)
      .join(', ');

    const totalCountWhere = getWhereWithoutBar();

    // Determine data source: use cohort MV, custom event CTE, or regular events table
    const dataSourceForBreakdown = useCohortMV
      ? TABLE_NAMES.profile_event_summary_mv
      : customEvent
        ? 'custom_event_data'
        : getEventsTableForRange(startDate);

    // Build cohort JOINs for breakdown_totals CTE
    // NOTE: ClickHouse CTEs cannot reference other CTEs in JOINs, so we inline the subquery
    const cohortJoinsForBreakdown = cohortIds
      .map((cohortId) => {
        const cohortMeta = cohortMetadata.get(cohortId);
        return buildInlineCohortJoin(
          cohortId,
          projectId,
          dataSourceForBreakdown,
          cohortMeta,
        );
      })
      .join(' ');

    addCte(
      'breakdown_totals',
      `SELECT
        ${breakdownSelects},
        uniq(${dataSourceForBreakdown}.profile_id) as total_count
       FROM ${dataSourceForBreakdown}
       ${profilesJoinRefForCTE ? `${profilesJoinRefForCTE} ` : ''}${cohortJoinsForBreakdown ? `${cohortJoinsForBreakdown} ` : ''}${totalCountWhere}
       GROUP BY ${breakdownGroupBy}`,
    );

    const joinConditions = breakdowns
      .map((b, index) => {
        const propertyKey = getSelectPropertyKey(
          b.name,
          projectId,
          b.cohortId,
          b.cohortId ? cohortMetadata.get(b.cohortId)?.name : undefined,
        );
        return `breakdown_totals.breakdown_${index + 1} = ${propertyKey}`;
      })
      .join(' AND ');

    sb.joins.breakdown_totals = `LEFT JOIN breakdown_totals ON ${joinConditions}`;
    sb.select.total_unique_count = `any(breakdown_totals.total_count) as total_count`;
  } else {
    const totalCountWhere = getWhereWithoutBar();

    // Determine data source: use cohort MV, custom event CTE, or regular events table
    const dataSourceForTotal = useCohortMV
      ? TABLE_NAMES.profile_event_summary_mv
      : customEvent
        ? 'custom_event_data'
        : getEventsTableForRange(startDate);

    // Build cohort JOINs for total_unique CTE
    // NOTE: ClickHouse CTEs cannot reference other CTEs in JOINs, so we inline the subquery
    const cohortJoinsForTotal = cohortIds
      .map((cohortId) => {
        const cohortMeta = cohortMetadata.get(cohortId);
        return buildInlineCohortJoin(
          cohortId,
          projectId,
          dataSourceForTotal,
          cohortMeta,
        );
      })
      .join(' ');

    addCte(
      'total_unique',
      `SELECT uniq(${dataSourceForTotal}.profile_id) as total_count
       FROM ${dataSourceForTotal}
       ${profilesJoinRefForCTE ? `${profilesJoinRefForCTE} ` : ''}${cohortJoinsForTotal ? `${cohortJoinsForTotal} ` : ''}${totalCountWhere}`,
    );

    // CROSS JOIN (not a scalar subquery) so filter columns inside total_unique
    // (e.g. `platform`) bind to total_unique's own FROM, not the outer `e`.
    // The `(SELECT total_count FROM total_unique)` scalar-subquery form makes
    // ClickHouse's analyzer treat a bare filter column as a correlated reference
    // to `e.<col>` and fail ("Resolved identifier ... with correlated column").
    // total_unique returns exactly one row, so CROSS JOIN never fans out.
    sb.joins.total_unique = `CROSS JOIN total_unique`;
    sb.select.total_unique_count = `any(total_unique.total_count) as total_count`;
  }

  const sql = `${getWith()}${getSelect()} ${getFrom()} ${getJoins()} ${getWhere()} ${getGroupBy()} ${getOrderBy()} ${getFill()}`;
  console.log('-- Report --');
  console.log(sql.replaceAll(/[\n\r]/g, ' '));
  console.log('-- End --');
  return sql;
}

function isNumericColumn(columnName: string): boolean {
  const numericColumns = ['duration', 'revenue', 'longitude', 'latitude'];
  return numericColumns.includes(columnName);
}

/**
 * Setup CTE for custom event expansion
 * Modifies the sql builder to use custom event data instead of events table
 */
async function setupCustomEventCTE(
  sb: any,
  addCte: (name: string, query: string) => void,
  customEvent: { name: string; definition: ICustomEventDefinition },
  projectId: string,
  startDate: string,
  endDate: string,
) {
  const baseWhere: string[] = [];
  if (startDate) {
    baseWhere.push(
      `created_at >= toDateTime('${formatClickhouseDate(startDate)}')`,
    );
  }
  if (endDate) {
    baseWhere.push(
      `created_at <= toDateTime('${formatClickhouseDate(endDate)}')`,
    );
  }

  const customEventSQL = await expandCustomEventToSQL(
    { ...customEvent, projectId },
    baseWhere,
    undefined,
    startDate,
  );

  addCte('custom_event_data', customEventSQL);
  // Alias as `e` so the shared join clauses (cohort breakdown at
  // getCohortJoin / getProfileJoin, all keyed on `e.profile_id`) resolve — the
  // non-custom path sets `<events table> e`, so custom events must match. Without
  // the alias, a custom-event chart WITH a cohort breakdown fails with
  // "Unknown expression identifier `e.profile_id`".
  sb.from = 'custom_event_data e';
}

export function getEventFiltersWhereClause(
  filters: IChartEventFilter[],
  projectId?: string,
) {
  const where: Record<string, string> = {};
  filters.forEach((filter, index) => {
    const id = `f${index}`;
    const { name, value, operator, cohortId } = filter;

    // Handle cohort operators - use JOIN-based approach
    if (operator === 'inCohort' && cohortId && projectId) {
      const cohortAlias = getCohortAlias(cohortId);
      where[id] = `notEmpty(${cohortAlias}.profile_id)`;
      return;
    }

    if (operator === 'notInCohort' && cohortId && projectId) {
      const cohortAlias = getCohortAlias(cohortId);
      where[id] = `empty(${cohortAlias}.profile_id)`;
      return;
    }

    if (
      value.length === 0 &&
      operator !== 'isNull' &&
      operator !== 'isNotNull'
    ) {
      return;
    }

    if (name === 'has_profile') {
      if (value.includes('true')) {
        where[id] = 'e.profile_id != e.device_id';
      } else {
        where[id] = 'e.profile_id = e.device_id';
      }
      return;
    }

    if (
      name.startsWith('properties.') ||
      name.startsWith('profile.properties.')
    ) {
      const propertyKey = getSelectPropertyKey(name, projectId);
      const isWildcard = propertyKey.includes('%');
      const whereFrom = getSelectPropertyKey(name, projectId);

      switch (operator) {
        case 'is': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map((val) => `x = ${sqlstring.escape(String(val).trim())}`)
              .join(' OR ')}, ${whereFrom})`;
          } else {
            if (value.length === 1) {
              where[id] =
                `${whereFrom} = ${sqlstring.escape(String(value[0]).trim())}`;
            } else {
              where[id] = `${whereFrom} IN (${value
                .map((val) => sqlstring.escape(String(val).trim()))
                .join(', ')})`;
            }
          }
          break;
        }
        case 'isNot': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map((val) => `x != ${sqlstring.escape(String(val).trim())}`)
              .join(' OR ')}, ${whereFrom})`;
          } else {
            if (value.length === 1) {
              where[id] =
                `${whereFrom} != ${sqlstring.escape(String(value[0]).trim())}`;
            } else {
              where[id] = `${whereFrom} NOT IN (${value
                .map((val) => sqlstring.escape(String(val).trim()))
                .join(', ')})`;
            }
          }
          break;
        }
        case 'contains': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `x LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`,
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `${whereFrom} LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`,
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'doesNotContain': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `x NOT LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`,
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `${whereFrom} NOT LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`,
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'startsWith': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) => `x LIKE ${sqlstring.escape(`${String(val).trim()}%`)}`,
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `${whereFrom} LIKE ${sqlstring.escape(`${String(val).trim()}%`)}`,
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'endsWith': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) => `x LIKE ${sqlstring.escape(`%${String(val).trim()}`)}`,
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `${whereFrom} LIKE ${sqlstring.escape(`%${String(val).trim()}`)}`,
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'regex': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map((val) => `match(x, ${sqlstring.escape(String(val).trim())})`)
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `match(${whereFrom}, ${sqlstring.escape(String(val).trim())})`,
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'isNull': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> x = '' OR x IS NULL, ${whereFrom})`;
          } else {
            where[id] = `(${whereFrom} = '' OR ${whereFrom} IS NULL)`;
          }
          break;
        }
        case 'isNotNull': {
          if (isWildcard) {
            where[id] =
              `arrayExists(x -> x != '' AND x IS NOT NULL, ${whereFrom})`;
          } else {
            where[id] = `(${whereFrom} != '' AND ${whereFrom} IS NOT NULL)`;
          }
          break;
        }
        case 'gt': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `toFloat64OrZero(x) > toFloat64(${sqlstring.escape(String(val).trim())})`,
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64OrZero(${whereFrom}) > toFloat64(${sqlstring.escape(String(val).trim())})`,
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'lt': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `toFloat64OrZero(x) < toFloat64(${sqlstring.escape(String(val).trim())})`,
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64OrZero(${whereFrom}) < toFloat64(${sqlstring.escape(String(val).trim())})`,
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'gte': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `toFloat64OrZero(x) >= toFloat64(${sqlstring.escape(String(val).trim())})`,
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64OrZero(${whereFrom}) >= toFloat64(${sqlstring.escape(String(val).trim())})`,
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'lte': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `toFloat64OrZero(x) <= toFloat64(${sqlstring.escape(String(val).trim())})`,
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64OrZero(${whereFrom}) <= toFloat64(${sqlstring.escape(String(val).trim())})`,
              )
              .join(' OR ')})`;
          }
          break;
        }
      }
    } else {
      switch (operator) {
        case 'is': {
          if (value.length === 1) {
            where[id] =
              `${name} = ${sqlstring.escape(String(value[0]).trim())}`;
          } else {
            where[id] = `${name} IN (${value
              .map((val) => sqlstring.escape(String(val).trim()))
              .join(', ')})`;
          }
          break;
        }
        case 'isNull': {
          where[id] = `(${name} = '' OR ${name} IS NULL)`;
          break;
        }
        case 'isNotNull': {
          where[id] = `(${name} != '' AND ${name} IS NOT NULL)`;
          break;
        }
        case 'isNot': {
          if (value.length === 1) {
            where[id] =
              `${name} != ${sqlstring.escape(String(value[0]).trim())}`;
          } else {
            where[id] = `${name} NOT IN (${value
              .map((val) => sqlstring.escape(String(val).trim()))
              .join(', ')})`;
          }
          break;
        }
        case 'contains': {
          where[id] = `(${value
            .map(
              (val) =>
                `${name} LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`,
            )
            .join(' OR ')})`;
          break;
        }
        case 'doesNotContain': {
          where[id] = `(${value
            .map(
              (val) =>
                `${name} NOT LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`,
            )
            .join(' OR ')})`;
          break;
        }
        case 'startsWith': {
          where[id] = `(${value
            .map(
              (val) =>
                `${name} LIKE ${sqlstring.escape(`${String(val).trim()}%`)}`,
            )
            .join(' OR ')})`;
          break;
        }
        case 'endsWith': {
          where[id] = `(${value
            .map(
              (val) =>
                `${name} LIKE ${sqlstring.escape(`%${String(val).trim()}`)}`,
            )
            .join(' OR ')})`;
          break;
        }
        case 'regex': {
          where[id] = `(${value
            .map(
              (val) =>
                `match(${name}, ${sqlstring.escape(stripLeadingAndTrailingSlashes(String(val)).trim())})`,
            )
            .join(' OR ')})`;
          break;
        }
        case 'gt': {
          if (isNumericColumn(name)) {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64(${name}) > toFloat64(${sqlstring.escape(String(val).trim())})`,
              )
              .join(' OR ')})`;
          } else {
            where[id] = `(${value
              .map((val) => `${name} > ${sqlstring.escape(String(val).trim())}`)
              .join(' OR ')})`;
          }
          break;
        }
        case 'lt': {
          if (isNumericColumn(name)) {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64(${name}) < toFloat64(${sqlstring.escape(String(val).trim())})`,
              )
              .join(' OR ')})`;
          } else {
            where[id] = `(${value
              .map((val) => `${name} < ${sqlstring.escape(String(val).trim())}`)
              .join(' OR ')})`;
          }
          break;
        }
        case 'gte': {
          if (isNumericColumn(name)) {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64(${name}) >= toFloat64(${sqlstring.escape(String(val).trim())})`,
              )
              .join(' OR ')})`;
          } else {
            where[id] = `(${value
              .map(
                (val) => `${name} >= ${sqlstring.escape(String(val).trim())}`,
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'lte': {
          if (isNumericColumn(name)) {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64(${name}) <= toFloat64(${sqlstring.escape(String(val).trim())})`,
              )
              .join(' OR ')})`;
          } else {
            where[id] = `(${value
              .map(
                (val) => `${name} <= ${sqlstring.escape(String(val).trim())}`,
              )
              .join(' OR ')})`;
          }
          break;
        }
      }
    }
  });

  return where;
}

export function getChartStartEndDate(
  {
    startDate,
    endDate,
    range,
  }: Pick<IChartInput, 'endDate' | 'startDate' | 'range'>,
  timezone: string,
) {
  if (startDate && endDate) {
    return { startDate: startDate, endDate: endDate };
  }

  const ranges = getDatesFromRange(range, timezone);
  if (!startDate && endDate) {
    return { startDate: ranges.startDate, endDate: endDate };
  }
  // "Since" — a start with no end rolls forward to now.
  if (startDate && !endDate) {
    const rolledEndDate = DateTime.now()
      .setZone(timezone)
      .endOf('day')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    return { startDate, endDate: rolledEndDate };
  }

  return ranges;
}

export function getDatesFromRange(range: IChartRange, timezone: string) {
  if (range === '30min' || range === 'lastHour') {
    const minutes = range === '30min' ? 30 : 60;
    const startDate = DateTime.now()
      .minus({ minute: minutes })
      .startOf('minute')
      .setZone(timezone)
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .endOf('minute')
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === 'today') {
    const startDate = DateTime.now()
      .setZone(timezone)
      .startOf('day')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .endOf('day')
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === 'yesterday') {
    const startDate = DateTime.now()
      .minus({ day: 1 })
      .setZone(timezone)
      .startOf('day')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .minus({ day: 1 })
      .setZone(timezone)
      .endOf('day')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === '21d') {
    const startDate = DateTime.now()
      .minus({ day: 21 })
      .setZone(timezone)
      .startOf('day')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .endOf('day')
      .plus({ millisecond: 1 })
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === '3d') {
    const startDate = DateTime.now()
      .minus({ day: 3 })
      .setZone(timezone)
      .startOf('day')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .endOf('day')
      .plus({ millisecond: 1 })
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === '7d') {
    const startDate = DateTime.now()
      .minus({ day: 7 })
      .setZone(timezone)
      .startOf('day')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .endOf('day')
      .plus({ millisecond: 1 })
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === '3m') {
    const startDate = DateTime.now()
      .minus({ month: 3 })
      .setZone(timezone)
      .startOf('day')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .endOf('day')
      .plus({ millisecond: 1 })
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === '6m') {
    const startDate = DateTime.now()
      .minus({ month: 6 })
      .setZone(timezone)
      .startOf('day')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .endOf('day')
      .plus({ millisecond: 1 })
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === '12m') {
    const startDate = DateTime.now()
      .minus({ month: 12 })
      .setZone(timezone)
      .startOf('month')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .endOf('month')
      .plus({ millisecond: 1 })
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === 'monthToDate') {
    const startDate = DateTime.now()
      .setZone(timezone)
      .startOf('month')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .endOf('day')
      .plus({ millisecond: 1 })
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === 'lastMonth') {
    const month = DateTime.now()
      .minus({ month: 1 })
      .setZone(timezone)
      .startOf('month');

    const startDate = month.toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = month
      .endOf('month')
      .plus({ millisecond: 1 })
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === 'yearToDate') {
    const startDate = DateTime.now()
      .setZone(timezone)
      .startOf('year')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .endOf('day')
      .plus({ millisecond: 1 })
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === 'lastYear') {
    const year = DateTime.now().minus({ year: 1 }).setZone(timezone);
    const startDate = year.startOf('year').toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = year.endOf('year').toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  // range === '30d'
  const startDate = DateTime.now()
    .minus({ day: 30 })
    .setZone(timezone)
    .startOf('day')
    .toFormat('yyyy-MM-dd HH:mm:ss');
  const endDate = DateTime.now()
    .setZone(timezone)
    .endOf('day')
    .plus({ millisecond: 1 })
    .toFormat('yyyy-MM-dd HH:mm:ss');

  return {
    startDate: startDate,
    endDate: endDate,
  };
}

export function getChartPrevStartEndDate({
  startDate,
  endDate,
}: {
  startDate: string;
  endDate: string;
}) {
  let diff = DateTime.fromFormat(endDate, 'yyyy-MM-dd HH:mm:ss').diff(
    DateTime.fromFormat(startDate, 'yyyy-MM-dd HH:mm:ss'),
  );

  // this will make sure our start and end date's are correct
  // otherwise if a day ends with 23:59:59.999 and starts with 00:00:00.000
  // the diff will be 23:59:59.999 and that will make the start date wrong
  // so we add 1 millisecond to the diff
  if ((diff.milliseconds / 1000) % 2 !== 0) {
    diff = diff.plus({ millisecond: 1 });
  }

  return {
    startDate: DateTime.fromFormat(startDate, 'yyyy-MM-dd HH:mm:ss')
      .minus({ millisecond: diff.milliseconds })
      .toFormat('yyyy-MM-dd HH:mm:ss'),
    endDate: DateTime.fromFormat(endDate, 'yyyy-MM-dd HH:mm:ss')
      .minus({ millisecond: diff.milliseconds })
      .toFormat('yyyy-MM-dd HH:mm:ss'),
  };
}
