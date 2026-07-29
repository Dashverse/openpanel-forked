import type { ClickHouseSettings } from '@clickhouse/client';
import { uniq } from 'ramda';
import sqlstring from 'sqlstring';

import { strip, toObject } from '@openpanel/common';
import { cacheable } from '@openpanel/redis';
import type { IChartEventFilter } from '@openpanel/validation';

import { profileBuffer } from '../buffers';
import {
  TABLE_NAMES,
  ch,
  chQuery,
  convertClickhouseDateToJs,
  formatClickhouseDate,
} from '../clickhouse/client';
import { createSqlBuilder } from '../sql-builder';
import { getOrganizationByProjectIdCached } from './organization.service';

export type IProfileMetrics = {
  lastSeen: Date;
  firstSeen: Date;
  screenViews: number;
  sessions: number;
  durationAvg: number;
  durationP90: number;
  totalEvents: number;
  uniqueDaysActive: number;
  bounceRate: number;
  avgEventsPerSession: number;
  conversionEvents: number;
  avgTimeBetweenSessions: number;
  revenue: number;
};
export function getProfileMetrics(profileId: string, projectId: string) {
  return chQuery<
    Omit<IProfileMetrics, 'lastSeen' | 'firstSeen'> & {
      lastSeen: string;
      firstSeen: string;
    }
  >(`
    WITH lastSeen AS (
      SELECT max(created_at) as lastSeen FROM ${TABLE_NAMES.events} WHERE profile_id = ${sqlstring.escape(profileId)} AND project_id = ${sqlstring.escape(projectId)}
    ),
    firstSeen AS (
      SELECT min(created_at) as firstSeen FROM ${TABLE_NAMES.events} WHERE profile_id = ${sqlstring.escape(profileId)} AND project_id = ${sqlstring.escape(projectId)}
    ),
    screenViews AS (
      SELECT count(*) as screenViews FROM ${TABLE_NAMES.events} WHERE name = 'screen_view' AND profile_id = ${sqlstring.escape(profileId)} AND project_id = ${sqlstring.escape(projectId)}
    ),
    sessions AS (
      SELECT count(*) as sessions FROM ${TABLE_NAMES.events} WHERE name = 'session_start' AND profile_id = ${sqlstring.escape(profileId)} AND project_id = ${sqlstring.escape(projectId)}
    ),
    duration AS (
      SELECT 
        round(avg(duration) / 1000 / 60, 2) as durationAvg, 
        round(quantilesExactInclusive(0.9)(duration)[1] / 1000 / 60, 2) as durationP90 
      FROM ${TABLE_NAMES.events} 
      WHERE name = 'session_end' AND duration != 0 AND profile_id = ${sqlstring.escape(profileId)} AND project_id = ${sqlstring.escape(projectId)}
    ),
    totalEvents AS (
      SELECT count(*) as totalEvents FROM ${TABLE_NAMES.events} WHERE profile_id = ${sqlstring.escape(profileId)} AND project_id = ${sqlstring.escape(projectId)}
    ),
    uniqueDaysActive AS (
      SELECT count(DISTINCT toDate(created_at)) as uniqueDaysActive FROM ${TABLE_NAMES.events} WHERE profile_id = ${sqlstring.escape(profileId)} AND project_id = ${sqlstring.escape(projectId)}
    ),
    bounceRate AS (
      SELECT round(avg(properties['__bounce'] = '1') * 100, 4) as bounceRate FROM ${TABLE_NAMES.events} WHERE name = 'session_end' AND profile_id = ${sqlstring.escape(profileId)} AND project_id = ${sqlstring.escape(projectId)}
    ),
    avgEventsPerSession AS (
      SELECT round((SELECT totalEvents FROM totalEvents) / nullIf((SELECT sessions FROM sessions), 0), 2) as avgEventsPerSession
    ),
    conversionEvents AS (
      SELECT count(*) as conversionEvents FROM ${TABLE_NAMES.events} WHERE name NOT IN ('screen_view', 'session_start', 'session_end') AND profile_id = ${sqlstring.escape(profileId)} AND project_id = ${sqlstring.escape(projectId)}
    ),
    avgTimeBetweenSessions AS (
      SELECT 
        CASE 
          WHEN (SELECT sessions FROM sessions) <= 1 THEN 0
          ELSE round(dateDiff('second', (SELECT firstSeen FROM firstSeen), (SELECT lastSeen FROM lastSeen)) / nullIf((SELECT sessions FROM sessions) - 1, 0), 1)
        END as avgTimeBetweenSessions
    ),
    revenue AS (
      SELECT sum(revenue) as revenue FROM ${TABLE_NAMES.events} WHERE name = 'revenue' AND profile_id = ${sqlstring.escape(profileId)} AND project_id = ${sqlstring.escape(projectId)}
    )
    SELECT 
      (SELECT lastSeen FROM lastSeen) as lastSeen, 
      (SELECT firstSeen FROM firstSeen) as firstSeen, 
      (SELECT screenViews FROM screenViews) as screenViews, 
      (SELECT sessions FROM sessions) as sessions, 
      (SELECT durationAvg FROM duration) as durationAvg, 
      (SELECT durationP90 FROM duration) as durationP90,
      (SELECT totalEvents FROM totalEvents) as totalEvents,
      (SELECT uniqueDaysActive FROM uniqueDaysActive) as uniqueDaysActive,
      (SELECT bounceRate FROM bounceRate) as bounceRate,
      (SELECT avgEventsPerSession FROM avgEventsPerSession) as avgEventsPerSession,
      (SELECT conversionEvents FROM conversionEvents) as conversionEvents,
      (SELECT avgTimeBetweenSessions FROM avgTimeBetweenSessions) as avgTimeBetweenSessions,
      (SELECT revenue FROM revenue) as revenue
  `)
    .then((data) => data[0]!)
    .then((data) => {
      return {
        ...data,
        lastSeen: convertClickhouseDateToJs(data.lastSeen),
        firstSeen: convertClickhouseDateToJs(data.firstSeen),
      };
    });
}

export async function getProfileById(id: string, projectId: string) {
  if (id === '' || projectId === '') {
    return null;
  }

  const cachedProfile = await profileBuffer.fetchFromCache(id, projectId);
  if (cachedProfile) {
    return transformProfile(cachedProfile);
  }

  const [profile] = await chQuery<IClickhouseProfile>(
    `SELECT
      id,
      project_id,
      nullIf(first_name, '') as first_name,
      nullIf(last_name, '') as last_name,
      nullIf(email, '') as email,
      nullIf(avatar, '') as avatar,
      is_external,
      properties,
      created_at
    FROM ${TABLE_NAMES.profiles}
    WHERE project_id = ${sqlstring.escape(projectId)} AND id = ${sqlstring.escape(String(id))}
    ORDER BY created_at DESC
    LIMIT 1`,
    undefined,
    true,
  );

  if (!profile) {
    return null;
  }

  // Write back to cache so subsequent reads within TTL skip ClickHouse
  profileBuffer.writeToCache(profile).catch(() => {});

  return transformProfile(profile);
}

/**
 * "did event OP N times" threshold on the behavioural filter. Compares each
 * profile's total count of the event (in the window) against value(s).
 * `between`/`notBetween` use both `value` and `value2`. All operators are
 * evaluated over the audience "profiles who did the event at least once" — the
 * only rows the summary tables hold — so `lt`/`lte` mean "did it few times",
 * not "including profiles that never did it".
 */
export type ProfileEventCountOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'notBetween';
export interface IProfileEventCount {
  operator: ProfileEventCountOp;
  value: number;
  value2?: number;
}

interface GetProfileListOptions {
  projectId: string;
  take: number;
  cursor?: number;
  filters?: IChartEventFilter[];
  events?: string[];
  range?: string;
  startDate?: string | null;
  endDate?: string | null;
  search?: string;
  isExternal?: boolean;
  /** Sort direction for the "Last seen" (created_at) column. Default DESC. */
  lastSeenDir?: 'ASC' | 'DESC';
  /** Optional last-seen window (hour-precise) bounding profiles.created_at. */
  lastSeenStart?: string | null;
  lastSeenEnd?: string | null;
  /** "did event OP N times" threshold (behavioural path). */
  eventCount?: IProfileEventCount;
}

// Build a HAVING comparison for a count expression (`countMerge(event_count)`
// on v2, or `count()` on the raw-events fallback). Returns null when the
// threshold is a no-op (unset, or `>= 1` — every listed profile did it ≥1) or
// malformed (between without a second value), so callers can skip it.
function countHavingClause(
  countExpr: string,
  ec: IProfileEventCount | undefined,
): string | null {
  if (!ec) return null;
  const v = Math.max(0, Math.floor(ec.value));
  const hasV2 = ec.value2 !== undefined && ec.value2 !== null;
  const v2 = hasV2 ? Math.max(0, Math.floor(ec.value2!)) : undefined;
  const lo = v2 !== undefined ? Math.min(v, v2) : v;
  const hi = v2 !== undefined ? Math.max(v, v2) : v;
  switch (ec.operator) {
    case 'eq':
      return `${countExpr} = ${v}`;
    case 'ne':
      return `${countExpr} != ${v}`;
    case 'gt':
      return `${countExpr} > ${v}`;
    case 'gte':
      return v <= 1 ? null : `${countExpr} >= ${v}`;
    case 'lt':
      return `${countExpr} < ${v}`;
    case 'lte':
      return `${countExpr} <= ${v}`;
    case 'between':
      return v2 === undefined ? null : `${countExpr} BETWEEN ${lo} AND ${hi}`;
    case 'notBetween':
      return v2 === undefined
        ? null
        : `${countExpr} NOT BETWEEN ${lo} AND ${hi}`;
    default:
      return null;
  }
}

// Rough range→days map for the behavioral subquery's time bound (v1). Custom
// start/end takes precedence; otherwise default to 30 days.
const RANGE_TO_DAYS: Record<string, number> = {
  '30min': 1,
  lastHour: 1,
  today: 1,
  yesterday: 2,
  '3d': 3,
  '7d': 7,
  '21d': 21,
  '30d': 30,
  '3m': 90,
  '6m': 180,
  '12m': 365,
};

function behavioralTimeClause(
  range: string | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  tz: string,
): string {
  if (startDate && endDate) {
    // The picker gives a naive wall-clock the user reads in the project's
    // timezone. toDateTime(str, tz) interprets it there and yields the correct
    // UTC instant to compare against created_at (stored UTC).
    return `created_at BETWEEN toDateTime(${sqlstring.escape(startDate)}, ${sqlstring.escape(tz)}) AND toDateTime(${sqlstring.escape(endDate)}, ${sqlstring.escape(tz)})`;
  }
  const days = RANGE_TO_DAYS[range ?? '30d'] ?? 30;
  return `created_at >= now() - INTERVAL ${days} DAY`;
}

// ─── v2 property MV routing for the behavioural filter ───────────────────────
// The behavioural filter ("profiles who did event X where properties.k=v")
// runs `profiles FINAL WHERE created_at BETWEEN <window> AND id IN (SELECT
// profile_id FROM events …)`. The inner events scan is ~7s on a high-volume
// event.
//
// Fix: swap ONLY the inner subquery to `profile_event_property_summary_v2` —
// its sort key (project, name, property_key, property_value) makes the
// event+property lookup a near-instant prefix scan. The outer profiles query is
// unchanged, so "Last seen" stays `profiles.created_at` (precise, windowed,
// sorted) and the seen-window still prunes profiles — feeding the v2 id-set
// into `profiles FINAL` measured ~350ms vs ~7s. Correctness bonus: v2 has no
// `WHERE profile_id != device_id` filter, so anonymous-heavy events count fully.
//
// Guards (route ONLY when ALL true):
//   1. Project is in the env allowlist — controlled per-project rollout.
//   2. Query date range starts on/after the env START_DATE — v2 only covers a
//      recent window (see docs/v2-migration-progress.md); default skips the
//      known 07-10 PM / 07-11 gap.
//   3. At most one property filter, and it targets a `properties.*` key — v2
//      does NOT store bare event columns (country/os/path/…) or handle
//      multi-property (needs INTERSECT; deferred).
// Any false → fall back to the existing events-table subquery (unchanged).
const PROFILES_BEHAVIORAL_V2_PROJECTS = new Set(
  (process.env.PROFILES_BEHAVIORAL_V2_PROJECTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
// Default 2026-07-12 skips the live-MV gap (07-10 11:36 → 07-11 15:58 UTC)
// documented in v2-migration-progress.md. Drop to 2026-07-01 via env once the
// 07-10 → 07-12 recovery backfill lands.
// Anchored to UTC (both this and queryStart) so the gate is deterministic
// regardless of server timezone. A blank/garbled env value falls back to the
// default instead of silently disabling the guard — `new Date('') `is Invalid
// Date, and `queryStart < InvalidDate` is always false (guard would never fire).
const PROFILES_BEHAVIORAL_V2_START_DATE = (() => {
  const raw = process.env.PROFILES_BEHAVIORAL_V2_START_DATE?.trim() || '2026-07-12';
  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? new Date('2026-07-12T00:00:00Z')
    : parsed;
})();

function canRouteBehavioralToV2(
  projectId: string,
  filters: IChartEventFilter[],
  range: string | undefined,
  startDate: string | null | undefined,
): boolean {
  if (!PROFILES_BEHAVIORAL_V2_PROJECTS.has(projectId)) return false;
  // Parse the naive wall-clock as UTC so the comparison matches START_DATE's
  // frame (a ~few-hours tz slop at the boundary only flips slow-vs-fast routing,
  // never correctness — the fallback path is also correct).
  const queryStart = startDate
    ? new Date(`${startDate.replace(' ', 'T')}Z`)
    : new Date(Date.now() - (RANGE_TO_DAYS[range ?? '30d'] ?? 30) * 86400_000);
  if (Number.isNaN(queryStart.getTime())) return false;
  if (queryStart < PROFILES_BEHAVIORAL_V2_START_DATE) return false;
  const active = (filters ?? []).filter((f) => f.name && f.value?.length);
  // Require EXACTLY ONE properties.* filter. v2 is keyed by
  // (project_id, name, property_key, property_value, …) so it only wins when we
  // can pin property_key+property_value for a prefix scan (~345ms). With ZERO
  // property filters ("did event X at all"), v2 is the WRONG table: each event
  // is ARRAY JOIN-exploded into one row per property, so a name-only scan reads
  // ~10× the event volume across every property combo — far slower than the
  // events fallback. So: 0 filters → events; >1 filters → needs INTERSECT
  // (deferred); exactly 1 properties.* → v2.
  if (active.length !== 1) return false;
  if (!active[0]!.name!.startsWith('properties.')) return false;
  return true;
}

// Full operator support for a value filter, mirroring chart.service.ts. `col` is
// the SQL expression the operator compares (property_value, properties['x'], or
// a bare column). Fixes the old "every unhandled operator falls through to IN"
// bug — e.g. doesNotContain used to emit `col IN (...)`, the exact opposite set.
function operatorClause(
  col: string,
  operator: string | undefined,
  values: (string | number | boolean | null)[],
): string {
  const trimmed = values.map((v) => String(v).trim());
  const esc = (v: string) => sqlstring.escape(v);
  const inList = trimmed.map(esc).join(', ');
  const anyLike = (pat: (v: string) => string) =>
    `(${trimmed.map((v) => `${col} LIKE ${esc(pat(v))}`).join(' OR ')})`;
  switch (operator) {
    case 'isNot':
      return `${col} NOT IN (${inList})`;
    case 'contains':
      return anyLike((v) => `%${v}%`);
    case 'doesNotContain':
      return `(${trimmed.map((v) => `${col} NOT LIKE ${esc(`%${v}%`)}`).join(' OR ')})`;
    case 'startsWith':
      return anyLike((v) => `${v}%`);
    case 'endsWith':
      return anyLike((v) => `%${v}`);
    case 'regex':
      return `(${trimmed.map((v) => `match(${col}, ${esc(v)})`).join(' OR ')})`;
    case 'isNull':
      return `(${col} = '' OR ${col} IS NULL)`;
    case 'isNotNull':
      return `(${col} != '' AND ${col} IS NOT NULL)`;
    case 'gt':
      return `(${trimmed.map((v) => `toFloat64OrZero(${col}) > toFloat64(${esc(v)})`).join(' OR ')})`;
    case 'lt':
      return `(${trimmed.map((v) => `toFloat64OrZero(${col}) < toFloat64(${esc(v)})`).join(' OR ')})`;
    case 'gte':
      return `(${trimmed.map((v) => `toFloat64OrZero(${col}) >= toFloat64(${esc(v)})`).join(' OR ')})`;
    case 'lte':
      return `(${trimmed.map((v) => `toFloat64OrZero(${col}) <= toFloat64(${esc(v)})`).join(' OR ')})`;
    default: // 'is' and any unknown operator
      return `${col} IN (${inList})`;
  }
}

// A `profile.*` filter targets a PROFILE attribute, not an event property:
//   profile.id / profile.email / …  → the column
//   profile.properties.<k>          → properties['<k>']
// It must apply to the outer `profiles` query, never the event subquery (where
// `profile.id` isn't even a column). Splitting these out is what makes a
// "did event X AND profile.id = Y" filter actually filter by id.
const isProfileFilter = (f: IChartEventFilter) =>
  !!f.name?.startsWith('profile.');

function profileAttrFilterClauses(filters: IChartEventFilter[]): string[] {
  const out: string[] = [];
  for (const f of filters) {
    if (!f.name || !f.value?.length) continue;
    let col: string;
    if (f.name.startsWith('profile.properties.')) {
      col = `properties[${sqlstring.escape(f.name.replace('profile.properties.', ''))}]`;
    } else {
      const bare = f.name.replace(/^profile\./, '');
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(bare)) continue;
      col = bare;
    }
    out.push(operatorClause(col, f.operator, f.value));
  }
  return out;
}

function buildBehavioralV2WhereClause(
  projectId: string,
  eventNames: string[],
  filters: IChartEventFilter[],
  range: string | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  tz: string,
): string {
  const names = eventNames.map((e) => sqlstring.escape(e)).join(',');
  const active = (filters ?? []).filter((f) => f.name && f.value?.length)[0];

  // `event_date` is `toStartOfDay(created_at)` computed in UTC — a UTC-day
  // bucket. The window (start/end) is wall-clock in the project tz, so we must
  // align the bound to UTC days too: `toTimeZone(toDateTime(x, tz), 'UTC')`
  // gives the same instant re-tagged UTC, and `toStartOfDay` then truncates to
  // the UTC midnight that matches how event_date was stored. Truncating in the
  // project tz instead lands ~half a day off and silently drops the last UTC
  // day of the window — under-counting membership AND the count near the end.
  const timeClause =
    startDate && endDate
      ? `event_date >= toStartOfDay(toTimeZone(toDateTime(${sqlstring.escape(startDate)}, ${sqlstring.escape(tz)}), 'UTC')) AND event_date <= toStartOfDay(toTimeZone(toDateTime(${sqlstring.escape(endDate)}, ${sqlstring.escape(tz)}), 'UTC'))`
      : `event_date >= toStartOfDay(now() - INTERVAL ${RANGE_TO_DAYS[range ?? '30d'] ?? 30} DAY)`;

  const parts = [
    `project_id = ${sqlstring.escape(projectId)}`,
    `name IN (${names})`,
    timeClause,
  ];

  if (active) {
    const key = active.name!.replace(/^properties\./, '');
    parts.push(`property_key = ${sqlstring.escape(key)}`);
    parts.push(operatorClause('property_value', active.operator, active.value!));
  }

  return parts.join(' AND ');
}

// v2-backed behavioural subquery — a drop-in replacement for the `events`
// subquery. Same shape (`SELECT DISTINCT profile_id … WHERE …`), so the outer
// profiles query is untouched: the "Last seen" column stays `profiles.created_at`
// (precise, windowed, sorted) exactly as PR #371, and the created_at seen-window
// prunes profiles so feeding the id-set into `profiles FINAL` stays fast
// (~350ms measured vs ~7s for the events scan).
function buildBehavioralV2Subquery(
  projectId: string,
  eventNames: string[],
  filters: IChartEventFilter[],
  range: string | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  tz: string,
  eventCount: IProfileEventCount | undefined,
): string {
  const where = buildBehavioralV2WhereClause(
    projectId,
    eventNames,
    filters,
    range,
    startDate,
    endDate,
    tz,
  );
  // Apply the same exact-window clamp + count threshold as the two-step path, so
  // the search+behavioral list (which routes through here, not the two-step)
  // matches the count and honours "OP N times". Without a HAVING, a plain
  // DISTINCT is enough and cheaper.
  const having = buildBehavioralV2Having(startDate, endDate, tz, eventCount);
  if (having) {
    return `SELECT profile_id FROM ${TABLE_NAMES.profile_event_property_summary_v2} WHERE ${where} GROUP BY profile_id ${having}`;
  }
  return `SELECT DISTINCT profile_id FROM ${TABLE_NAMES.profile_event_property_summary_v2} WHERE ${where}`;
}

// The behavioural membership id-set: profiles who did the event(s) (with the
// event-property filters + count threshold), as an `IN (…)` subquery. Routes to
// v2 when allowed, else raw events. Shared by the list (buildSql) and the count
// so they can never disagree on membership.
function buildBehavioralIdSubquery(
  projectId: string,
  eventNames: string[],
  eventFilters: IChartEventFilter[],
  range: string | undefined,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  tz: string,
  eventCount: IProfileEventCount | undefined,
): string {
  if (canRouteBehavioralToV2(projectId, eventFilters, range, startDate)) {
    return buildBehavioralV2Subquery(
      projectId,
      eventNames,
      eventFilters,
      range,
      startDate,
      endDate,
      tz,
      eventCount,
    );
  }
  const names = eventNames.map((e) => sqlstring.escape(e)).join(',');
  const parts = [
    `project_id = ${sqlstring.escape(projectId)}`,
    `name IN (${names})`,
    behavioralTimeClause(range, startDate, endDate, tz),
    ...eventFilterClauses(eventFilters),
  ];
  const countClause = countHavingClause('count()', eventCount);
  return countClause
    ? `SELECT profile_id FROM ${TABLE_NAMES.events} WHERE ${parts.join(' AND ')} GROUP BY profile_id HAVING ${countClause}`
    : `SELECT DISTINCT profile_id FROM ${TABLE_NAMES.events} WHERE ${parts.join(' AND ')}`;
}

// HAVING clause for the v2 behavioural path. Two jobs:
//  1. EXACT-window clamp on `last_event_time` (stored at ms precision, UTC).
//     The `event_date` WHERE bound is UTC-day granular and over-includes the
//     partial edge days (e.g. a 09:00→13:59 IST window leaks 05:30 IST / next-
//     day 05:29 IST rows). Clamping the merged max to the exact instant window
//     makes membership + the displayed "Last seen" strictly "last did the event
//     WITHIN the window". Straddlers whose last event is after the window are
//     excluded (their last activity isn't in-window) — this is the intended
//     "who did this in this window" semantic, and it's why the clamped count is
//     lower than the UTC-day count.
//  2. Optional "≥ N times" threshold on the summed count.
// Both reference merge-state aggregates, so this is valid in any GROUP BY
// profile_id context (list rank query AND the count subquery).
function buildBehavioralV2Having(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  tz: string,
  eventCount: IProfileEventCount | undefined,
): string {
  const parts: string[] = [];
  if (startDate && endDate) {
    parts.push(
      `maxMerge(last_event_time) >= toDateTime(${sqlstring.escape(startDate)}, ${sqlstring.escape(tz)})`,
      `maxMerge(last_event_time) <= toDateTime(${sqlstring.escape(endDate)}, ${sqlstring.escape(tz)})`,
    );
  }
  const countClause = countHavingClause('countMerge(event_count)', eventCount);
  if (countClause) parts.push(countClause);
  return parts.length ? `HAVING ${parts.join(' AND ')}` : '';
}

// Two-step v2 behavioural list — "Last seen" = the EXACT last time the profile
// did the event with the property, sorted by it.
//
// v2 stores `maxState(created_at) AS last_event_time` per
// (project_id, name, property_key, property_value, profile_id), so
// `maxMerge(last_event_time)` is the real ms-precision last-event timestamp
// (UTC), NOT the day-granular `event_date` bucket. (event_date is only the
// GROUP BY key / partition prune.)
//
// Step 1 ranks INSIDE v2 (group/sort/limit on the property-prefix range) and
// returns only one page of (profile_id, last_seen). Step 2 hydrates just those
// ids from `profiles` by exact PK — so a huge match set never touches
// `profiles FINAL`. Step 3 emits in rank order with createdAt overridden to
// last_seen.
//
// Deliberately NO is_external filter: the behavioural view mixes anonymous +
// identified profiles (a profile can do the event pre- and post-identify, and
// v2's profile_id is anon device_id before identify). Membership here matches
// getProfileListCount, which also counts uniq(profile_id) over v2 with no
// is_external.
async function getBehavioralV2ProfileList(opts: {
  projectId: string;
  eventNames: string[];
  filters: IChartEventFilter[];
  range: string | undefined;
  startDate: string | null | undefined;
  endDate: string | null | undefined;
  tz: string;
  take: number;
  offset: number;
  orderDir: 'ASC' | 'DESC';
  eventCount?: IProfileEventCount;
}): Promise<IServiceProfile[]> {
  const where = buildBehavioralV2WhereClause(
    opts.projectId,
    opts.eventNames,
    opts.filters,
    opts.range,
    opts.startDate,
    opts.endDate,
    opts.tz,
  );
  // Exact-window clamp on last_event_time + optional "≥ N times". See
  // buildBehavioralV2Having — makes "Last seen" strictly within the window.
  const having = buildBehavioralV2Having(
    opts.startDate,
    opts.endDate,
    opts.tz,
    opts.eventCount,
  );

  // Step 1 — rank in v2. All the heavy lifting (aggregate + sort + limit)
  // happens on the property-prefix range; only `take` rows come back.
  const ranked = await chQuery<{ profile_id: string; last_seen: string }>(
    `SELECT profile_id, maxMerge(last_event_time) AS last_seen
     FROM ${TABLE_NAMES.profile_event_property_summary_v2}
     WHERE ${where}
     GROUP BY profile_id
     ${having}
     ORDER BY last_seen ${opts.orderDir}
     LIMIT ${opts.take} OFFSET ${opts.offset}`,
    undefined,
    true,
  );
  if (ranked.length === 0) return [];

  // Step 2 — hydrate this page by id via getProfiles (GROUP BY id + any/
  // last_value, NO FINAL). FINAL here is catastrophic: `profiles FINAL WHERE id
  // IN (50)` merges across every monthly partition (~17M rows / ~2.1s on prod),
  // dwarfing the rank query; the no-FINAL aggregation returns the same result
  // in ~190ms.
  const ids = ranked.map((r) => r.profile_id);
  const hydrated = await getProfiles(ids, opts.projectId);
  const byId = new Map(hydrated.map((p) => [p.id, p]));

  // Step 3 — emit in v2 rank order with "Last seen" = last_seen (exact UTC ms).
  // A ranked id with no profile row yet (event seen, profile never upserted)
  // still shows so the page stays full and consistent with the count.
  return ranked.map(({ profile_id, last_seen }) => {
    const createdAt = convertClickhouseDateToJs(last_seen);
    const p = byId.get(profile_id);
    if (p) return { ...p, createdAt };
    return {
      id: profile_id,
      email: '',
      avatar: '',
      firstName: '',
      lastName: '',
      createdAt,
      isExternal: false,
      projectId: opts.projectId,
      properties: {},
    };
  });
}

// Two-step behavioural list on the RAW events table — the fallback for anything
// v2 can't serve (name-only, multi-key, non-allowlisted). Same shape as the v2
// two-step: rank profiles by the exact last-event time (max(created_at)) INSIDE
// events, LIMIT to one page, then hydrate. Two wins over the old buildSql path:
//  1. "Last seen" = the real last EVENT time (not profiles.created_at, which is
//     the profile-record write time and can be months stale).
//  2. It never feeds a huge id-set into `profiles FINAL` — it ranks+limits in
//     events first, then hydrates only 50 ids (the old path did
//     `profiles FINAL WHERE id IN (every doer)` → ~20s on a high-volume event).
async function getBehavioralEventsProfileList(opts: {
  projectId: string;
  eventNames: string[];
  eventFilters: IChartEventFilter[];
  range: string | undefined;
  startDate: string | null | undefined;
  endDate: string | null | undefined;
  tz: string;
  take: number;
  offset: number;
  orderDir: 'ASC' | 'DESC';
  eventCount?: IProfileEventCount;
}): Promise<IServiceProfile[]> {
  const names = opts.eventNames.map((e) => sqlstring.escape(e)).join(',');
  const parts = [
    `project_id = ${sqlstring.escape(opts.projectId)}`,
    `name IN (${names})`,
    behavioralTimeClause(opts.range, opts.startDate, opts.endDate, opts.tz),
    ...eventFilterClauses(opts.eventFilters),
  ];
  const countClause = countHavingClause('count()', opts.eventCount);

  // Step 1 — rank in events by the last event time, one page only.
  const ranked = await chQuery<{ profile_id: string; last_seen: string }>(
    `SELECT profile_id, max(created_at) AS last_seen
     FROM ${TABLE_NAMES.events}
     WHERE ${parts.join(' AND ')}
     GROUP BY profile_id
     ${countClause ? `HAVING ${countClause}` : ''}
     ORDER BY last_seen ${opts.orderDir}
     LIMIT ${opts.take} OFFSET ${opts.offset}`,
    undefined,
    true,
  );
  if (ranked.length === 0) return [];

  // Step 2 — hydrate this page by id (no FINAL).
  const ids = ranked.map((r) => r.profile_id);
  const hydrated = await getProfiles(ids, opts.projectId);
  const byId = new Map(hydrated.map((p) => [p.id, p]));

  // Step 3 — emit in rank order, "Last seen" = the event's max(created_at).
  return ranked.map(({ profile_id, last_seen }) => {
    const createdAt = convertClickhouseDateToJs(last_seen);
    const p = byId.get(profile_id);
    if (p) return { ...p, createdAt };
    return {
      id: profile_id,
      email: '',
      avatar: '',
      firstName: '',
      lastName: '',
      createdAt,
      isExternal: false,
      projectId: opts.projectId,
      properties: {},
    };
  });
}

// v1 event-filter builder for the behavioral subquery. Maps `properties.x` to
// the events Map and leaves bare event columns (country/os/path/…) as-is.
function eventFilterClauses(filters: IChartEventFilter[]): string[] {
  const out: string[] = [];
  for (const f of filters) {
    if (!f.name || !f.value?.length) continue;
    let col: string;
    if (f.name.startsWith('properties.')) {
      col = `properties[${sqlstring.escape(f.name.replace(/^properties\./, ''))}]`;
    } else {
      // Bare event column (country/os/path/…). It's a SQL identifier, not a
      // string literal, so it can't be sqlstring.escape'd — reject anything that
      // isn't a plain identifier to block injection via a crafted filter name.
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f.name)) continue;
      col = f.name;
    }
    out.push(operatorClause(col, f.operator, f.value));
  }
  return out;
}

// PROFILE property filters — match on the profiles `properties` Map, e.g.
// properties['country'] IN ('IN'). Shared by the list and the count.
function profilePropertyFilterClauses(filters: IChartEventFilter[]): string[] {
  const out: string[] = [];
  for (const f of filters) {
    if (!f.name || !f.value?.length) continue;
    const col = `properties[${sqlstring.escape(f.name.replace(/^properties\./, ''))}]`;
    out.push(operatorClause(col, f.operator, f.value));
  }
  return out;
}

export async function getProfiles(ids: string[], projectId: string) {
  const filteredIds = uniq(ids.filter((id) => id !== ''));

  if (filteredIds.length === 0) {
    return [];
  }

  const data = await chQuery<IClickhouseProfile>(
    `SELECT
      id,
      project_id,
      any(nullIf(first_name, '')) as first_name,
      any(nullIf(last_name, '')) as last_name,
      any(nullIf(email, '')) as email,
      any(nullIf(avatar, '')) as avatar,
      last_value(is_external) as is_external,
      any(properties) as properties,
      any(created_at) as created_at
    FROM ${TABLE_NAMES.profiles}
    WHERE
      project_id = ${sqlstring.escape(projectId)} AND
      id IN (${filteredIds.map((id) => sqlstring.escape(id)).join(',')})
    GROUP BY id, project_id
    `,
    undefined,
    true,
  );

  return data.map(transformProfile);
}

export const getProfilesCached = cacheable(getProfiles, 60 * 5);

// Columns the profile LIST renders. `properties` IS needed here — the table's
// Country/OS/Browser/Model/Referrer columns read from it (e.g.
// properties['country']). ClickHouse Maps are read whole, so we can't cheaply
// select just those keys; the speedup comes from the recent-partition window +
// do_not_merge below, not from trimming columns.
const PROFILE_LIST_COLUMNS =
  'id, project_id, is_external, created_at, first_name, last_name, email, avatar, properties';

export async function getProfileList({
  take,
  cursor,
  projectId,
  search,
  isExternal,
  filters,
  events,
  range,
  startDate,
  endDate,
  lastSeenDir,
  lastSeenStart,
  lastSeenEnd,
  eventCount,
}: GetProfileListOptions) {
  // `['*']` (and '') is the "All Events" wildcard from the event picker — it
  // means "no behavioral filter", NOT an event literally named `*`. Strip it,
  // otherwise `name IN ('*')` matches nothing and returns 0 profiles.
  const eventNames = events?.filter((e) => e && e !== '*');
  // Split `profile.*` (profile-attribute) filters from event/property filters.
  // profile.* apply to the outer `profiles` query; the rest are event-property
  // filters (behavioural) or profile-property filters (no event selected).
  const allFilters = filters ?? [];
  const profileFilters = allFilters.filter(isProfileFilter);
  const eventFilters = allFilters.filter((f) => !isProfileFilter(f));
  // "Last seen" (created_at) sort + optional window. Default DESC. A window
  // bounds created_at (partition-pruned to the month(s)) so both directions run
  // in ~1.4s; only unbounded ASC is slow (full-table FINAL dedup, ~10s).
  const orderDir = lastSeenDir === 'ASC' ? 'ASC' : 'DESC';
  const hasSeenRange = !!(lastSeenStart && lastSeenEnd);
  // Project timezone: the date picker gives a naive wall-clock the user reads in
  // this tz. Cached 24h, so effectively free.
  const tz =
    (await getOrganizationByProjectIdCached(projectId))?.timezone || 'UTC';

  // Behavioural + v2-routable + no free-text search → two-step: rank by exact
  // last-event time in v2, hydrate the page. "Last seen" becomes the true last
  // time the profile did the event with the property (not profiles.created_at).
  // Search is a separate mode (id/fuzzy) and keeps the subquery-swap path below.
  // Behavioural + no search + no profile.* filter → a two-step that ranks by
  // the exact last-EVENT time and hydrates one page. "Last seen" = event time
  // on both branches. profile.* filters (need the outer profiles query) and
  // search (filters profiles) fall through to buildSql below.
  // `cursor` is already the row offset ((page-1)*take) — do NOT multiply again.
  const offset = Math.max(0, cursor ?? 0);
  if (!search && !profileFilters.length && eventNames?.length) {
    if (canRouteBehavioralToV2(projectId, eventFilters, range, startDate)) {
      return getBehavioralV2ProfileList({
        projectId,
        eventNames,
        filters: eventFilters,
        range,
        startDate,
        endDate,
        tz,
        take,
        offset,
        orderDir,
        eventCount,
      });
    }
    return getBehavioralEventsProfileList({
      projectId,
      eventNames,
      eventFilters,
      range,
      startDate,
      endDate,
      tz,
      take,
      offset,
      orderDir,
      eventCount,
    });
  }

  const buildSql = (opts: {
    recentOnly?: boolean;
    searchMode?: 'id' | 'fuzzy';
  }) => {
    const { sb, getSql } = createSqlBuilder();
    sb.from = `${TABLE_NAMES.profiles} FINAL`;
    sb.select.columns = PROFILE_LIST_COLUMNS;
    sb.where.project_id = `project_id = ${sqlstring.escape(projectId)}`;
    // The profiles.created_at window applies ONLY to the plain profile list.
    // - While SEARCHING: search must find a profile regardless of last-seen.
    // - With an EVENT filter: the event subquery already bounds by activity
    //   time; also gating profiles.created_at (= first-seen/record-write time)
    //   would drop established users who did the event recently, making the list
    //   diverge from the count (which is event-time-bounded). So skip it — the
    //   behavioural semantic is "did the event in the window", matching the v2
    //   two-step and the count.
    const applyWindow = !opts.searchMode && !eventNames?.length;
    // Prune to the most recent monthly partition(s). The newest profiles are by
    // definition the most recent, so this reads a tiny slice of history instead
    // of every version ever (~114M rows on dashreels).
    if (opts.recentOnly && !hasSeenRange && applyWindow) {
      sb.where.recent = 'created_at >= now() - INTERVAL 1 MONTH';
    }
    // Explicit last-seen window replaces the implicit month window. Monthly
    // partitioning prunes to the month(s); the BETWEEN narrows within (down to
    // the hour) for free.
    if (hasSeenRange && applyWindow) {
      sb.where.seen = `created_at BETWEEN toDateTime(${sqlstring.escape(lastSeenStart!)}, ${sqlstring.escape(tz)}) AND toDateTime(${sqlstring.escape(lastSeenEnd!)}, ${sqlstring.escape(tz)})`;
    }
    sb.limit = take;
    // `cursor` is already the row offset ((page-1)*take from the client).
    sb.offset = Math.max(0, cursor ?? 0);
    sb.orderBy.created_at = `created_at ${orderDir}`;
    if (opts.searchMode === 'id') {
      // Exact profile-id match: a primary-key point lookup (id is in the sort
      // key `(project_id, id)`), so it's ~instant regardless of table size.
      sb.where.search = `id = ${sqlstring.escape(search!)}`;
    } else if (opts.searchMode === 'fuzzy') {
      // Substring name/email search. ILIKE '%x%' can't use any index (the bloom
      // filters only help exact/token matches), so it scans — inherently slow.
      // Escape the user input: sqlstring.escape wraps + escapes so a crafted
      // `search` can't break out of the string literal (SQL injection).
      const like = sqlstring.escape(`%${search}%`);
      sb.where.search = `(email ILIKE ${like} OR first_name ILIKE ${like} OR last_name ILIKE ${like})`;
    }
    if (isExternal !== undefined) {
      sb.where.external = `is_external = ${isExternal ? 'true' : 'false'}`;
    }
    // profile.* filters (id / attributes / profile.properties.*) ALWAYS apply to
    // the outer profiles query, regardless of behavioural vs plain list.
    profileAttrFilterClauses(profileFilters).forEach((clause, i) => {
      sb.where[`prof${i}`] = clause;
    });
    if (eventNames?.length) {
      // BEHAVIORAL: users who did one of these events. Only the event-property
      // filters (eventFilters) go in the event subquery; profile.* were already
      // applied above. Routes to v2 (~350ms) or raw events; shared with the
      // count via buildBehavioralIdSubquery so they can't disagree.
      sb.where.behavioral = `id IN (${buildBehavioralIdSubquery(projectId, eventNames, eventFilters, range, startDate, endDate, tz, eventCount)})`;
    } else {
      // No event selected → treat the remaining (non-profile.*) filters as
      // PROFILE-property filters on the profiles table, e.g.
      // properties['country'] IN ('IN'). Cheap.
      profilePropertyFilterClauses(eventFilters).forEach((clause, i) => {
        sb.where[`pf${i}`] = clause;
      });
    }
    return getSql();
  };

  // do_not_merge_across_partitions_select_final is safe here: a profile's
  // created_at (the ReplacingMergeTree version AND the partition key) is stable
  // across updates, so all versions of a profile live in one monthly partition —
  // FINAL can dedupe per-partition instead of merging across all of history.
  const settings: ClickHouseSettings = {
    do_not_merge_across_partitions_select_final: 1,
  };

  let data: IClickhouseProfile[];
  if (search) {
    // Try an exact profile-id lookup first — a primary-key hit, so it's instant.
    // Most "search" here is really "find this exact profile id".
    data = await chQuery<IClickhouseProfile>(
      buildSql({ searchMode: 'id' }),
      settings,
      true,
    );
    if (data.length === 0) {
      // No id match → fall back to the (slow) fuzzy name/email scan.
      data = await chQuery<IClickhouseProfile>(
        buildSql({ searchMode: 'fuzzy' }),
        settings,
        true,
      );
    }
  } else if (eventNames?.length) {
    // Behavioral filter: the events subquery already bounds the range, so the
    // profiles-side month window is pointless and would only trigger the
    // window→fallback double query (and could miss users whose profile is older
    // than a month). Run once, unwindowed.
    data = await chQuery<IClickhouseProfile>(
      buildSql({ recentOnly: false }),
      settings,
      true,
    );
  } else if (hasSeenRange) {
    // Explicit last-seen window: partition-pruned to the month(s), so both sort
    // directions run in ~1.4s. No month-window fallback needed.
    data = await chQuery<IClickhouseProfile>(
      buildSql({ recentOnly: false }),
      settings,
      true,
    );
  } else if (orderDir === 'DESC') {
    // Fast path: last month only (prunes partitions → ~0.5s vs ~20s). Fall back
    // to the full range if it doesn't fill the page — a low-activity project, or
    // paging past the window.
    data = await chQuery<IClickhouseProfile>(
      buildSql({ recentOnly: true }),
      settings,
      true,
    );
    if (data.length < take) {
      data = await chQuery<IClickhouseProfile>(
        buildSql({ recentOnly: false }),
        settings,
        true,
      );
    }
  } else {
    // Ascending with no window: the month window would give "oldest within the
    // last month" (wrong — they want the oldest overall), so run unwindowed.
    // This is the one slow path (~10s full-table FINAL dedup); the UI nudges a
    // date range, which makes it ~1.4s.
    data = await chQuery<IClickhouseProfile>(
      buildSql({ recentOnly: false }),
      settings,
      true,
    );
  }

  return data.map(transformProfile);
}

export async function getProfileListCount({
  projectId,
  isExternal,
  search,
  filters,
  events,
  range,
  startDate,
  endDate,
  lastSeenStart,
  lastSeenEnd,
  eventCount,
}: Omit<GetProfileListOptions, 'cursor' | 'take'>) {
  // Strip the `['*']`/'' "All Events" wildcard — see getProfileList.
  const eventNames = events?.filter((e) => e && e !== '*');
  const allFilters = filters ?? [];
  const profileFilters = allFilters.filter(isProfileFilter);
  const eventFilters = allFilters.filter((f) => !isProfileFilter(f));
  const hasSeenRange = !!(lastSeenStart && lastSeenEnd);
  const tz =
    (await getOrganizationByProjectIdCached(projectId))?.timezone || 'UTC';

  const behavioralSubquery = eventNames?.length
    ? buildBehavioralIdSubquery(
        projectId,
        eventNames,
        eventFilters,
        range,
        startDate,
        endDate,
        tz,
        eventCount,
      )
    : null;

  // FAST PATH — behavioural with no profile.* filter and no search: count the
  // event id-set directly (v2 HLL / grouped count), matching the two-step list.
  if (behavioralSubquery && !profileFilters.length && !search) {
    if (canRouteBehavioralToV2(projectId, eventFilters, range, startDate)) {
      const where = buildBehavioralV2WhereClause(
        projectId,
        eventNames!,
        eventFilters,
        range,
        startDate,
        endDate,
        tz,
      );
      const having = buildBehavioralV2Having(startDate, endDate, tz, eventCount);
      const sql = having
        ? `SELECT count() as count FROM (SELECT profile_id FROM ${TABLE_NAMES.profile_event_property_summary_v2} WHERE ${where} GROUP BY profile_id ${having})`
        : `SELECT uniq(profile_id) as count FROM ${TABLE_NAMES.profile_event_property_summary_v2} WHERE ${where}`;
      const data = await chQuery<{ count: number }>(sql, undefined, true);
      return data[0]?.count ?? 0;
    }
    const data = await chQuery<{ count: number }>(
      `SELECT count() as count FROM (${behavioralSubquery})`,
      undefined,
      true,
    );
    return data[0]?.count ?? 0;
  }

  // GENERAL PATH — count over `profiles` with the SAME WHERE as the list:
  // behavioural membership (id IN …) + profile.* filters + search + window +
  // profile-property filters. `searchClause` lets us mirror the list's
  // id-first-then-fuzzy fallback.
  const buildCount = (searchClause?: string) => {
    const { sb, getSql } = createSqlBuilder();
    sb.from = 'profiles';
    sb.select.count = 'uniq(id) as count';
    sb.where.project_id = `project_id = ${sqlstring.escape(projectId)}`;
    sb.groupBy.project_id = 'project_id';
    // Window applies only to the plain list — not while searching or with an
    // event filter (the event subquery bounds time). Mirrors getProfileList.
    if (hasSeenRange && !search && !eventNames?.length) {
      sb.where.seen = `created_at BETWEEN toDateTime(${sqlstring.escape(lastSeenStart!)}, ${sqlstring.escape(tz)}) AND toDateTime(${sqlstring.escape(lastSeenEnd!)}, ${sqlstring.escape(tz)})`;
    }
    if (isExternal !== undefined) {
      sb.where.external = `is_external = ${isExternal ? 'true' : 'false'}`;
    }
    if (searchClause) sb.where.search = searchClause;
    profileAttrFilterClauses(profileFilters).forEach((clause, i) => {
      sb.where[`prof${i}`] = clause;
    });
    if (behavioralSubquery) {
      sb.where.behavioral = `id IN (${behavioralSubquery})`;
    } else {
      profilePropertyFilterClauses(eventFilters).forEach((clause, i) => {
        sb.where[`pf${i}`] = clause;
      });
    }
    return getSql();
  };

  if (search) {
    // Mirror the list: exact profile-id first (instant PK lookup), else fuzzy.
    const idRes = await chQuery<{ count: number }>(
      buildCount(`id = ${sqlstring.escape(search)}`),
      undefined,
      true,
    );
    if ((idRes[0]?.count ?? 0) > 0) return idRes[0]!.count;
    const like = sqlstring.escape(`%${search}%`);
    const fuzzyRes = await chQuery<{ count: number }>(
      buildCount(
        `(email ILIKE ${like} OR first_name ILIKE ${like} OR last_name ILIKE ${like})`,
      ),
      undefined,
      true,
    );
    return fuzzyRes[0]?.count ?? 0;
  }

  const data = await chQuery<{ count: number }>(buildCount(), undefined, true);
  return data[0]?.count ?? 0;
}

export type IServiceProfile = {
  id: string;
  email: string;
  avatar: string;
  firstName: string;
  lastName: string;
  createdAt: Date;
  isExternal: boolean;
  projectId: string;
  properties: Record<string, unknown> & {
    region?: string;
    country?: string;
    city?: string;
    os?: string;
    os_version?: string;
    browser?: string;
    browser_version?: string;
    referrer_name?: string;
    referrer_type?: string;
    device?: string;
    brand?: string;
    model?: string;
    referrer?: string;
  };
};

export interface IClickhouseProfile {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  avatar: string;
  properties: Record<string, string | undefined>;
  project_id: string;
  is_external: boolean;
  created_at: string;
}

export interface IServiceUpsertProfile {
  projectId: string;
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  avatar?: string;
  properties?: Record<string, unknown>;
  isExternal: boolean;
}

export function transformProfile({
  created_at,
  first_name,
  last_name,
  ...profile
}: IClickhouseProfile): IServiceProfile {
  return {
    firstName: first_name,
    lastName: last_name,
    isExternal: profile.is_external,
    // `properties` is selected on both the list and single-profile queries;
    // guard against a nullish Map (older rows / fixtures) with {}.
    properties: toObject(profile.properties ?? {}),
    createdAt: convertClickhouseDateToJs(created_at),
    projectId: profile.project_id,
    id: profile.id,
    email: profile.email,
    avatar: profile.avatar,
  };
}

export async function upsertProfile(
  {
    id,
    firstName,
    lastName,
    email,
    avatar,
    properties,
    projectId,
    isExternal,
  }: IServiceUpsertProfile,
  isFromEvent = false,
) {
  const profile: IClickhouseProfile = {
    id,
    first_name: firstName || '',
    last_name: lastName || '',
    email: email || '',
    avatar: avatar || '',
    properties: strip((properties as Record<string, string | undefined>) || {}),
    project_id: projectId,
    created_at: formatClickhouseDate(new Date()),
    is_external: isExternal,
  };

  return profileBuffer.add(profile, isFromEvent);
}

export interface IServiceUpsertAlias {
  projectId: string;
  /** The canonical (identified) profile id, e.g. the backend user id. */
  profileId: string;
  /** The previous anonymous id the events were stamped with. */
  alias: string;
}

/**
 * Persist an `(anonymous id) -> (identified id)` mapping into `profile_aliases`.
 *
 * We follow Mixpanel's identity model: we never rewrite event rows. The alias
 * row is written once on sign-in and resolved at query time (in a later PR).
 *
 * Volume is one row per sign-in transition, so we insert directly rather than
 * going through a buffer. Guards drop self-maps / empty ids so we never create
 * a chain (an alias that is also a canonical) or a no-op row.
 */
export async function upsertAlias({
  projectId,
  profileId,
  alias,
}: IServiceUpsertAlias) {
  if (!projectId || !profileId || !alias || alias === profileId) {
    return;
  }

  await ch.insert({
    table: TABLE_NAMES.alias,
    values: [
      {
        project_id: projectId,
        profile_id: profileId,
        alias,
        created_at: formatClickhouseDate(new Date()),
      },
    ],
    format: 'JSONEachRow',
    // Aliases are written one row at a time per sign-in batch (the proxy
    // re-emits per batch). async_insert lets ClickHouse coalesce these into
    // server-side batches (~1 part/sec) instead of a part per insert, which
    // matters at scale on this single-partition ReplacingMergeTree. The
    // client-level CLICKHOUSE_SETTINGS does not enable it, so set it here.
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 0,
    },
  });
}
