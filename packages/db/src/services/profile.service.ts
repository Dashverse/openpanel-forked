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

// v1 event-filter builder for the behavioral subquery. Maps `properties.x` to
// the events Map and leaves bare event columns (country/os/path/…) as-is.
function eventFilterClauses(filters: IChartEventFilter[]): string[] {
  const out: string[] = [];
  for (const f of filters) {
    if (!f.name || !f.value?.length) continue;
    const col = f.name.startsWith('properties.')
      ? `properties[${sqlstring.escape(f.name.replace(/^properties\./, ''))}]`
      : f.name;
    const inList = f.value.map((v) => sqlstring.escape(String(v))).join(',');
    if (f.operator === 'isNot') {
      out.push(`${col} NOT IN (${inList})`);
    } else if (f.operator === 'contains') {
      out.push(
        `(${f.value.map((v) => `${col} ILIKE ${sqlstring.escape(`%${v}%`)}`).join(' OR ')})`,
      );
    } else {
      out.push(`${col} IN (${inList})`);
    }
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
    const inList = f.value.map((v) => sqlstring.escape(String(v))).join(',');
    if (f.operator === 'isNot') {
      out.push(`${col} NOT IN (${inList})`);
    } else if (f.operator === 'contains') {
      out.push(
        `(${f.value.map((v) => `${col} ILIKE ${sqlstring.escape(`%${v}%`)}`).join(' OR ')})`,
      );
    } else {
      out.push(`${col} IN (${inList})`);
    }
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
}: GetProfileListOptions) {
  // `['*']` (and '') is the "All Events" wildcard from the event picker — it
  // means "no behavioral filter", NOT an event literally named `*`. Strip it,
  // otherwise `name IN ('*')` matches nothing and returns 0 profiles.
  const eventNames = events?.filter((e) => e && e !== '*');
  // "Last seen" (created_at) sort + optional window. Default DESC. A window
  // bounds created_at (partition-pruned to the month(s)) so both directions run
  // in ~1.4s; only unbounded ASC is slow (full-table FINAL dedup, ~10s).
  const orderDir = lastSeenDir === 'ASC' ? 'ASC' : 'DESC';
  const hasSeenRange = !!(lastSeenStart && lastSeenEnd);
  // Project timezone: the date picker gives a naive wall-clock the user reads in
  // this tz. Cached 24h, so effectively free.
  const tz =
    (await getOrganizationByProjectIdCached(projectId))?.timezone || 'UTC';
  const buildSql = (opts: {
    recentOnly?: boolean;
    searchMode?: 'id' | 'fuzzy';
  }) => {
    const { sb, getSql } = createSqlBuilder();
    sb.from = `${TABLE_NAMES.profiles} FINAL`;
    sb.select.columns = PROFILE_LIST_COLUMNS;
    sb.where.project_id = `project_id = ${sqlstring.escape(projectId)}`;
    // Prune to the most recent monthly partition(s). The newest profiles are by
    // definition the most recent, so this reads a tiny slice of history instead
    // of every version ever (~114M rows on dashreels).
    if (opts.recentOnly && !hasSeenRange) {
      sb.where.recent = 'created_at >= now() - INTERVAL 1 MONTH';
    }
    // Explicit last-seen window replaces the implicit month window. Monthly
    // partitioning prunes to the month(s); the BETWEEN narrows within (down to
    // the hour) for free.
    if (hasSeenRange) {
      sb.where.seen = `created_at BETWEEN toDateTime(${sqlstring.escape(lastSeenStart!)}, ${sqlstring.escape(tz)}) AND toDateTime(${sqlstring.escape(lastSeenEnd!)}, ${sqlstring.escape(tz)})`;
    }
    sb.limit = take;
    sb.offset = Math.max(0, (cursor ?? 0) * take);
    sb.orderBy.created_at = `created_at ${orderDir}`;
    if (opts.searchMode === 'id') {
      // Exact profile-id match: a primary-key point lookup (id is in the sort
      // key `(project_id, id)`), so it's ~instant regardless of table size.
      sb.where.search = `id = ${sqlstring.escape(search!)}`;
    } else if (opts.searchMode === 'fuzzy') {
      // Substring name/email search. ILIKE '%x%' can't use any index (the bloom
      // filters only help exact/token matches), so it scans — inherently slow.
      sb.where.search = `(email ILIKE '%${search}%' OR first_name ILIKE '%${search}%' OR last_name ILIKE '%${search}%')`;
    }
    if (isExternal !== undefined) {
      sb.where.external = `is_external = ${isExternal ? 'true' : 'false'}`;
    }
    if (eventNames?.length) {
      // BEHAVIORAL (v1): users who did one of these events — the `filters` are
      // applied as EVENT-property filters (e.g. showOpen where source='X') and
      // bounded by the selected date range. Subquery over the events table
      // (~7s on large projects).
      const names = eventNames.map((e) => sqlstring.escape(e)).join(',');
      const parts = [
        `project_id = ${sqlstring.escape(projectId)}`,
        `name IN (${names})`,
        behavioralTimeClause(range, startDate, endDate, tz),
        ...eventFilterClauses(filters ?? []),
      ];
      sb.where.behavioral = `id IN (SELECT DISTINCT profile_id FROM ${TABLE_NAMES.events} WHERE ${parts.join(' AND ')})`;
    } else {
      // No event selected → treat `filters` as PROFILE-property filters on the
      // profiles table, e.g. properties['country'] IN ('IN'). Cheap.
      profilePropertyFilterClauses(filters ?? []).forEach((clause, i) => {
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
}: Omit<GetProfileListOptions, 'cursor' | 'take'>) {
  // Strip the `['*']`/'' "All Events" wildcard — see getProfileList.
  const eventNames = events?.filter((e) => e && e !== '*');
  const hasSeenRange = !!(lastSeenStart && lastSeenEnd);
  const tz =
    (await getOrganizationByProjectIdCached(projectId))?.timezone || 'UTC';
  // BEHAVIORAL: distinct profiles who did the event(s) in range — count over the
  // events subquery (same ~7s scan as the list). Mirrors the list's filter.
  if (eventNames?.length) {
    const names = eventNames.map((e) => sqlstring.escape(e)).join(',');
    const parts = [
      `project_id = ${sqlstring.escape(projectId)}`,
      `name IN (${names})`,
      behavioralTimeClause(range, startDate, endDate, tz),
      ...eventFilterClauses(filters ?? []),
    ];
    const data = await chQuery<{ count: number }>(
      `SELECT uniq(profile_id) as count FROM ${TABLE_NAMES.events} WHERE ${parts.join(' AND ')}`,
      undefined,
      true,
    );
    return data[0]?.count ?? 0;
  }

  if (search) {
    // Search mirrors the list: exact profile-id first (a PK point lookup, so
    // it's instant), then fall through to the fuzzy name/email scan below.
    // Without this an id-search returns 0 here even though the list shows the
    // row (the fuzzy clause only checks email/first_name/last_name).
    const idRes = await chQuery<{ count: number }>(
      `SELECT uniq(id) as count FROM ${TABLE_NAMES.profiles} WHERE project_id = ${sqlstring.escape(projectId)} AND id = ${sqlstring.escape(search)}${
        isExternal !== undefined
          ? ` AND is_external = ${isExternal ? 'true' : 'false'}`
          : ''
      }`,
      undefined,
      true,
    );
    if ((idRes[0]?.count ?? 0) > 0) {
      return idRes[0]!.count;
    }
  }

  // PROPERTY / no filter: uniq(id) over profiles. Unfiltered ~0.6s; a property
  // filter reads the Map across all versions so it's slower (~8s), but it makes
  // the count reflect the filter.
  const { sb, getSql } = createSqlBuilder();
  sb.from = 'profiles';
  // uniq(id) = approximate DISTINCT users (HLL, ~2% error). count(id) without
  // FINAL over-counts because it includes every ReplacingMergeTree version, and
  // uniqExact is ~4x slower.
  sb.select.count = 'uniq(id) as count';
  sb.where.project_id = `project_id = ${sqlstring.escape(projectId)}`;
  sb.groupBy.project_id = 'project_id';
  if (search) {
    sb.where.search = `(email ILIKE '%${search}%' OR first_name ILIKE '%${search}%' OR last_name ILIKE '%${search}%')`;
  }
  if (isExternal !== undefined) {
    sb.where.external = `is_external = ${isExternal ? 'true' : 'false'}`;
  }
  if (hasSeenRange) {
    // Reflect the last-seen window in the count too (partition-pruned, tz-aware).
    sb.where.seen = `created_at BETWEEN toDateTime(${sqlstring.escape(lastSeenStart!)}, ${sqlstring.escape(tz)}) AND toDateTime(${sqlstring.escape(lastSeenEnd!)}, ${sqlstring.escape(tz)})`;
  }
  profilePropertyFilterClauses(filters ?? []).forEach((clause, i) => {
    sb.where[`pf${i}`] = clause;
  });
  const data = await chQuery<{ count: number }>(getSql(), undefined, true);
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
    // The list query omits `properties` for speed; default to {} when absent.
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
