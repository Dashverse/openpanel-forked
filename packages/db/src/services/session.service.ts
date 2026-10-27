import type { ClickHouseSettings } from '@clickhouse/client';
import { createLogger } from '@openpanel/logger';
import { cacheable } from '@openpanel/redis';
import {
  type ReplaySessionFilterField,
  type ReplaySort,
  replaySessionNumericFields,
} from '@openpanel/constants';
import type { IChartEventFilter } from '@openpanel/validation';
import sqlstring from 'sqlstring';
import {
  TABLE_NAMES,
  ch,
  chQuery,
  formatClickhouseDate,
} from '../clickhouse/client';
import { clix } from '../clickhouse/query-builder';
import { createSqlBuilder } from '../sql-builder';
import { getEventFiltersWhereClause } from './chart.service';
import { getOrganizationByProjectIdCached } from './organization.service';
import { type IServiceProfile, getProfilesCached } from './profile.service';
import {
  REPLAY_BLOCKS_COMPLETE_SINCE_MS,
  type ReplayBlockChunk,
  type ReplayBlockRef,
  type ReplayIndexRow,
  type ReplayScopedKey,
  buildReplayIndex,
  computeReplayMeta,
  computeReplaySegments,
  computeReplayWindows,
  fetchReplayBlockRefs,
  isReplayAbortError,
  isReplayBlocksServingEnabled,
  loadReplayChunksFromBlocks,
  replayAnchorSeq,
  replayBlockSessionIdsSql,
  replayBlocksHaveChunkKeys,
  resolveReplayRefKeys,
  scopeReplayKeys,
} from './replay-block-reader';

export type IClickhouseSession = {
  id: string;
  profile_id: string;
  event_count: number;
  screen_view_count: number;
  entry_path: string;
  entry_origin: string;
  exit_path: string;
  exit_origin: string;
  created_at: string;
  ended_at: string;
  referrer: string;
  referrer_name: string;
  referrer_type: string;
  os: string;
  os_version: string;
  browser: string;
  browser_version: string;
  device: string;
  brand: string;
  model: string;
  country: string;
  region: string;
  city: string;
  longitude: number | null;
  latitude: number | null;
  is_bounce: boolean;
  project_id: string;
  device_id: string;
  duration: number;
  utm_medium: string;
  utm_source: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  revenue: number;
  sign: 1 | 0;
  version: number;
};

export interface IServiceSession {
  id: string;
  profileId: string;
  hasReplay?: boolean;
  /** Replays list only: number of recorded tabs (windows) in the session. */
  replayTabCount?: number;
  eventCount: number;
  screenViewCount: number;
  entryPath: string;
  entryOrigin: string;
  exitPath: string;
  exitOrigin: string;
  createdAt: Date;
  endedAt: Date;
  referrer: string;
  referrerName: string;
  referrerType: string;
  os: string;
  osVersion: string;
  browser: string;
  browserVersion: string;
  device: string;
  brand: string;
  model: string;
  country: string;
  region: string;
  city: string;
  longitude: number | null;
  latitude: number | null;
  isBounce: boolean;
  projectId: string;
  deviceId: string;
  duration: number;
  utmMedium: string;
  utmSource: string;
  utmCampaign: string;
  utmContent: string;
  utmTerm: string;
  revenue: number;
  profile?: IServiceProfile;
}

export interface GetSessionListOptions {
  projectId: string;
  profileId?: string;
  take: number;
  filters?: IChartEventFilter[];
  startDate?: Date;
  endDate?: Date;
  search?: string;
  cursor?: Cursor | null;
  /** When true, only return sessions that have a replay recording. Powers the
   *  Session Replays tab. Implemented as a `session_id IN (…)` subquery against
   *  session_replay_chunks, scoped to the same date window as the list. */
  onlyReplays?: boolean;
  /** Replay behavior filters (reuse the chart filter model): keep only sessions
   *  that fired one of `replayEventNames` and/or matched these event-property
   *  filters. Applied as an events subquery, so it's "session HAD an event that…"
   *  (not a session-column match). Built with getEventFiltersWhereClause. */
  replayEventNames?: string[];
  replayEventFilters?: IChartEventFilter[];
  /** Replays list only: session-column filters (country, OS, entry page…). */
  replaySessionFilters?: ReplaySessionFilter[];
  /** Replays list only: date window in days (1–90). Default: 14 (or the org's
   *  shorter lookback). */
  replayDays?: number;
  /** Replays list only: sort order. Default 'newest'. */
  replaySort?: ReplaySort;
  /** Replays list only: bounds on the RECORDING's active duration (ms) — the
   *  same idle-collapsed time the player shows. */
  minReplayDurationMs?: number;
  maxReplayDurationMs?: number;
}

export function transformSession(session: IClickhouseSession): IServiceSession {
  return {
    id: session.id,
    profileId: session.profile_id,
    eventCount: session.event_count,
    screenViewCount: session.screen_view_count,
    entryPath: session.entry_path,
    entryOrigin: session.entry_origin,
    exitPath: session.exit_path,
    exitOrigin: session.exit_origin,
    createdAt: new Date(session.created_at),
    endedAt: new Date(session.ended_at),
    referrer: session.referrer,
    referrerName: session.referrer_name,
    referrerType: session.referrer_type,
    os: session.os,
    osVersion: session.os_version,
    browser: session.browser,
    browserVersion: session.browser_version,
    device: session.device,
    brand: session.brand,
    model: session.model,
    country: session.country,
    region: session.region,
    city: session.city,
    longitude: session.longitude,
    latitude: session.latitude,
    isBounce: session.is_bounce,
    projectId: session.project_id,
    deviceId: session.device_id,
    duration: session.duration,
    utmMedium: session.utm_medium,
    utmSource: session.utm_source,
    utmCampaign: session.utm_campaign,
    utmContent: session.utm_content,
    utmTerm: session.utm_term,
    revenue: session.revenue,
    profile: undefined,
  };
}

type Direction = 'initial' | 'next' | 'prev';

type PageInfo = {
  next?: Cursor; // use last row
};

type Cursor = {
  createdAt: string; // ISO 8601 with ms
  id: string;
  /** Offset pagination for non-chronological replay sorts (duration/events). */
  offset?: number;
};

/**
 * Session-list search WHERE clause: EXACT user-id (profile_id) match. The old
 * name/email `ILIKE '%…%'` was removed on purpose — a leading-wildcard scan of
 * the profiles table is unaffordable at high scale (dashreels). Paste a UID.
 */
function buildSessionSearchWhere(search: string): string {
  return `profile_id = ${sqlstring.escape(search.trim())}`;
}

/**
 * Replays-list search: exact user id, OR a case-insensitive substring of the
 * user's id / email / name. Affordable because the profiles scan is scoped to
 * the profile ids of sessions that HAVE a replay in the window (a few thousand
 * ids, primary-key lookups) — never a project-wide wildcard scan. Measured
 * 0.31s on frameo over 14 days.
 */
function buildReplaySearchWhere(
  search: string,
  projectId: string,
  days: number,
): string {
  const q = sqlstring.escape(search.trim());
  const proj = sqlstring.escape(projectId);
  return `(profile_id = ${q} OR profile_id IN (
      SELECT id FROM ${TABLE_NAMES.profiles}
      WHERE project_id = ${proj}
        AND id IN (
          SELECT DISTINCT profile_id FROM ${TABLE_NAMES.sessions}
          WHERE project_id = ${proj} AND sign = 1
            AND created_at > now() - INTERVAL ${days} DAY
            AND ${buildHasReplayWhere(projectId, days)}
        )
        AND (positionCaseInsensitive(id, ${q}) > 0
          OR positionCaseInsensitive(email, ${q}) > 0
          OR positionCaseInsensitive(concat(first_name, ' ', last_name), ${q}) > 0)
    ))`;
}

const REPLAY_SESSION_FILTER_COLUMNS: Record<ReplaySessionFilterField, string> = {
  country: 'country',
  region: 'region',
  city: 'city',
  os: 'os',
  browser: 'browser',
  device: 'device',
  brand: 'brand',
  model: 'model',
  entryPath: 'entry_path',
  exitPath: 'exit_path',
  referrerName: 'referrer_name',
  referrerType: 'referrer_type',
  utmSource: 'utm_source',
  utmMedium: 'utm_medium',
  utmCampaign: 'utm_campaign',
  eventCount: 'event_count',
  screenViewCount: 'screen_view_count',
  isBounce: 'is_bounce',
};

export type ReplaySessionFilter = {
  name: ReplaySessionFilterField;
  operator: 'is' | 'isNot' | 'contains' | 'doesNotContain' | 'gte' | 'lte';
  value: string[];
};

/** WHERE fragments for session-column filters (plain columns on `sessions`). */
function buildReplaySessionFilterWhere(
  filters: ReplaySessionFilter[],
): Record<string, string> {
  const where: Record<string, string> = {};
  filters.forEach((f, i) => {
    const col = REPLAY_SESSION_FILTER_COLUMNS[f.name];
    const values = f.value.filter((v) => v !== '');
    if (!col || values.length === 0) return;
    const key = `sf_${i}`;
    if (f.name === 'isBounce') {
      where[key] = `${col} = ${values[0] === 'true' ? 1 : 0}`;
      return;
    }
    if (replaySessionNumericFields.includes(f.name)) {
      const n = Number(values[0]);
      if (!Number.isFinite(n)) return;
      where[key] = `${col} ${f.operator === 'lte' ? '<=' : '>='} ${Math.floor(n)}`;
      return;
    }
    const list = values.map((v) => sqlstring.escape(v)).join(', ');
    switch (f.operator) {
      case 'isNot':
        where[key] = `${col} NOT IN (${list})`;
        break;
      case 'contains':
        where[key] = `(${values.map((v) => `positionCaseInsensitive(${col}, ${sqlstring.escape(v)}) > 0`).join(' OR ')})`;
        break;
      case 'doesNotContain':
        where[key] = `(${values.map((v) => `positionCaseInsensitive(${col}, ${sqlstring.escape(v)}) = 0`).join(' AND ')})`;
        break;
      default:
        where[key] = `${col} IN (${list})`;
    }
  });
  return where;
}

/**
 * Distinct values (most common first) of a session field among sessions that
 * have a replay in the window — powers the filter value picker.
 */
export async function getReplaySessionFilterValues({
  projectId,
  field,
  days,
}: {
  projectId: string;
  field: ReplaySessionFilterField;
  days?: number;
}): Promise<{ value: string; count: number }[]> {
  const col = REPLAY_SESSION_FILTER_COLUMNS[field];
  if (!col || replaySessionNumericFields.includes(field) || field === 'isBounce') {
    return [];
  }
  const d = clampReplayDays(days) ?? (await getReplayLookbackDays(projectId));
  const rows = await chQuery<{ value: string; count: string }>(
    `SELECT ${col} AS value, toString(uniqExact(id)) AS count
     FROM ${TABLE_NAMES.sessions}
     WHERE project_id = ${sqlstring.escape(projectId)}
       AND sign = 1
       AND created_at > now() - INTERVAL ${d} DAY
       AND ${col} != ''
       AND ${buildHasReplayWhere(projectId, d)}
     GROUP BY value
     ORDER BY uniqExact(id) DESC
     LIMIT 100`,
  );
  return rows.map((r) => ({ value: r.value, count: Number(r.count) }));
}

/** Replays list date window: 1–90 days (90 = the chunk table's TTL). */
function clampReplayDays(days?: number): number | undefined {
  if (!days || !Number.isFinite(days)) return undefined;
  return Math.min(90, Math.max(1, Math.floor(days)));
}

/**
 * Session-id source for "which sessions HAVE a replay", within the `days`
 * window. When the Azure Blob archive is NOT configured (REPLAY_BLOB_CONN
 * empty) this is exactly the historical CH-only expression: DISTINCT session_id
 * from the hot `session_replay_chunks` table. When the archive IS configured we
 * UNION in the TTL-free `replay_archive_index`, so sessions whose chunks have
 * been trimmed out of ClickHouse (kept only in the Blob) still enumerate — the
 * list/count/has-replay flag survive a CH trim. The index is a
 * ReplacingMergeTree keyed on (project_id, session_id, dt): read it FINAL and
 * scope on its `dt` (Date) column (chunks scope on `started_at`).
 */
function buildReplayPresenceSubquery(projectId: string, days: number): string {
  return replayPresenceUnion(
    projectId,
    `started_at > now() - INTERVAL ${days} DAY
        AND started_at <= now()`,
    `dt > today() - ${days}
        AND dt <= today()`,
    `first_started_at > now() - INTERVAL ${days} DAY
        AND first_started_at <= now()`,
  );
}

/**
 * Same session-id source as buildReplayPresenceSubquery, scoped to an absolute
 * date range (padded by `padDays` either side, so a session whose recording
 * started before/after the range edge still counts) instead of "last N days".
 * Used by the funnel replays drill-down, whose range comes from the chart.
 */
export function buildReplayPresenceSubqueryForRange(
  projectId: string,
  startDate: string,
  endDate: string,
  padDays = 2,
): string {
  const start = sqlstring.escape(formatClickhouseDate(startDate));
  const end = sqlstring.escape(formatClickhouseDate(endDate));
  return replayPresenceUnion(
    projectId,
    `started_at >= toDateTime(${start}) - INTERVAL ${padDays} DAY
        AND started_at <= toDateTime(${end}) + INTERVAL ${padDays} DAY`,
    `dt >= toDate(toDateTime(${start})) - ${padDays}
        AND dt <= toDate(toDateTime(${end})) + ${padDays}`,
    `first_started_at >= toDateTime(${start}) - INTERVAL ${padDays} DAY
        AND first_started_at <= toDateTime(${end}) + INTERVAL ${padDays} DAY`,
  );
}

/**
 * Blocks-served projects (REPLAY_SERVE_BLOCKS_PROJECT_IDS) also enumerate
 * sessions from the blob-block refs, so a session written only to Blob
 * (REPLAY_BLOB_ONLY_PROJECT_IDS on the worker) still lists. Off → no change.
 */
function replayPresenceUnion(
  projectId: string,
  chunkWindow: string,
  archiveWindow: string,
  blockWindow: string,
): string {
  const proj = sqlstring.escape(projectId);
  const chunks = `SELECT DISTINCT session_id
      FROM ${TABLE_NAMES.session_replay_chunks}
      WHERE project_id = ${proj}
        AND ${chunkWindow}`;
  if (!REPLAY_BLOB_CONN) return chunks;
  const withArchive = `${chunks}
      UNION DISTINCT
      SELECT DISTINCT session_id
      FROM ${REPLAY_ARCHIVE_INDEX} FINAL
      WHERE project_id = ${proj}
        AND ${archiveWindow}`;
  if (!isReplayBlocksServingEnabled(projectId)) return withArchive;
  return `${withArchive}
      UNION DISTINCT
      ${replayBlockSessionIdsSql(projectId, blockWindow)}`;
}

/**
 * DISTINCT day set (column `d`) that actually has replays, within `days` — used
 * to prune session/event scans to the exact days chunks exist on. Blob OFF →
 * the historical CH-only day set (`toDate(started_at)` over chunks). Blob ON →
 * UNION the archived days (`dt` from `replay_archive_index` FINAL), so day-
 * pruning still covers sessions whose chunks were trimmed from ClickHouse.
 */
function buildReplayDaySubquery(projectId: string, days: number): string {
  const proj = sqlstring.escape(projectId);
  const chunkDays = `SELECT DISTINCT toDate(started_at) AS d
        FROM ${TABLE_NAMES.session_replay_chunks}
        WHERE project_id = ${proj}
          AND started_at > now() - INTERVAL ${days} DAY
          AND started_at <= now()`;
  if (!REPLAY_BLOB_CONN) return chunkDays;
  const withArchive = `${chunkDays}
        UNION DISTINCT
        SELECT DISTINCT dt AS d
        FROM ${REPLAY_ARCHIVE_INDEX} FINAL
        WHERE project_id = ${proj}
          AND dt > today() - ${days}`;
  if (!isReplayBlocksServingEnabled(projectId)) return withArchive;
  return `${withArchive}
        UNION DISTINCT
        SELECT DISTINCT toDate(first_started_at) AS d
        FROM ${TABLE_NAMES.session_replay_blocks}
        WHERE project_id = ${proj}
          AND first_started_at > now() - INTERVAL ${days} DAY
          AND first_started_at <= now()`;
}

/**
 * Replay behavior filter — "sessions that HAD an event matching X". Built as an
 * events subquery so it reuses the chart filter model (getEventFiltersWhereClause
 * builds the property WHERE against `events`) and the events sort key
 * (project_id, toDate, name, …) prunes `name` cheaply. The outer sessions query +
 * has-replay narrows the rest. e.g. name=pricingModalViewed, or platform=web.
 */
function buildReplayBehaviorWhere(
  projectId: string,
  days: number,
  eventNames?: string[],
  filters?: IChartEventFilter[],
): string {
  const proj = sqlstring.escape(projectId);
  const conds = [
    `project_id = ${proj}`,
    `created_at > now() - INTERVAL ${days} DAY`,
    // Prune the event scan to the days that actually have replays (same
    // data-derived trick as buildHasReplayWhere). Without this a high-frequency
    // event (e.g. showOpen) is scanned across the whole org window (360d, 100M+
    // rows). Replays are sparse/recent, so this cuts it to a handful of days.
    // The day set includes archived days (replay_archive_index) when the Blob
    // archive is on, so behavior filters still match sessions CH has trimmed.
    `toDate(created_at) IN (
        SELECT arrayJoin([d - 1, d])
        FROM (
          ${buildReplayDaySubquery(projectId, days)}
        )
      )`,
  ];
  if (eventNames?.length) {
    conds.push(
      `name IN (${eventNames.map((n) => sqlstring.escape(n)).join(', ')})`,
    );
  }
  if (filters?.length) {
    conds.push(...Object.values(getEventFiltersWhereClause(filters)));
  }
  return `id IN (
      SELECT DISTINCT session_id
      FROM ${TABLE_NAMES.events}
      WHERE ${conds.join(' AND ')}
    )`;
}

/**
 * Rolling lookback window (days) for session queries. Big organizations get a
 * tight 1-day window for performance; everyone else 360. Shared by
 * getSessionList and getSessionsCount so their date/replay windows can't drift.
 */
async function getSessionLookbackDays(projectId: string): Promise<number> {
  const organization = await getOrganizationByProjectIdCached(projectId);
  return organization?.subscriptionPeriodEventsLimit &&
    organization.subscriptionPeriodEventsLimit > 1_000_000
    ? 1
    : 360;
}

/**
 * The Session Replays list uses a much tighter default window than the org
 * lookback. Replays are recent (~90d TTL) and the list — especially event/
 * property filters that scan events (e.g. platform) — is slow over a 360-day
 * window at dashreels scale. Users widen it with the date-range filter.
 */
const REPLAY_LOOKBACK_DAYS = 14;

/** Minimum session duration (ms) for the replay list — hides trivial/empty
 *  recordings (PostHog's default is > 5s). */
const MIN_REPLAY_DURATION_MS = 5000;

async function getReplayLookbackDays(projectId: string): Promise<number> {
  return Math.min(await getSessionLookbackDays(projectId), REPLAY_LOOKBACK_DAYS);
}

/**
 * WHERE fragment keeping only sessions that have a replay recording.
 *
 * `sessions` is `ORDER BY (project_id, toDate(created_at), …)` /
 * `PARTITION BY toYYYYMM(created_at)`, and `id` is NOT in the sort key — so
 * `id IN (…)` alone cannot prune and full-scans the entire project (measured
 * 281M rows / 11.7 GiB / ~15-19s for dashreels → the replay tab times out).
 *
 * Fix: also constrain `created_at` to the exact days that actually have chunks.
 * ClickHouse then prunes to the relevant month-partitions and skips granules
 * down to just those days. This is derived from the data (the set of chunk
 * dates), so it adapts to any retention/TTL — we deliberately do NOT hardcode a
 * chunk-age cap. For a sparse/recent project this is a ~240x cut (dashreels
 * 15s → 0.06s); a project that records every day degrades gracefully to the
 * org-window scan. `d - 1` covers a session that started just before midnight
 * whose first chunk landed on the following day. `started_at <= now()` drops
 * corrupt future timestamps from the pruning set (e.g. a chunk stamped 2299).
 *
 * `days` is the caller's org lookback window (see getSessionLookbackDays) — the
 * same window the rest of the list uses, kept so the count and list agree.
 */
function buildHasReplayWhere(projectId: string, days: number): string {
  return `id IN (
      ${buildReplayPresenceSubquery(projectId, days)}
    )
    AND created_at > now() - INTERVAL ${days} DAY
    AND toDate(created_at) IN (
      SELECT arrayJoin([d - 1, d])
      FROM (
        ${buildReplayDaySubquery(projectId, days)}
      )
    )`;
}

export async function getSessionList({
  cursor,
  take,
  projectId,
  profileId,
  filters,
  startDate,
  endDate,
  search,
  onlyReplays,
  replayEventNames,
  replayEventFilters,
  replaySessionFilters,
  replayDays,
  replaySort = 'newest',
  minReplayDurationMs,
  maxReplayDurationMs,
}: GetSessionListOptions) {
  const { sb, getSql, getWhere } = createSqlBuilder();

  sb.from = `${TABLE_NAMES.sessions} FINAL`;
  sb.limit = take;
  sb.where.projectId = `project_id = ${sqlstring.escape(projectId)}`;

  // This will speed up the query quite a lot for big organizations. The
  // replays list takes an explicit window (1–90d) from its date filter.
  const dateIntervalInDays = onlyReplays
    ? (clampReplayDays(replayDays) ?? (await getReplayLookbackDays(projectId)))
    : await getSessionLookbackDays(projectId);

  if (startDate && endDate) {
    sb.where.range = `created_at BETWEEN toDateTime('${formatClickhouseDate(startDate)}') AND toDateTime('${formatClickhouseDate(endDate)}')`;
  }

  if (profileId)
    sb.where.profileId = `profile_id = ${sqlstring.escape(profileId)}`;
  if (search) {
    sb.where.search = onlyReplays
      ? buildReplaySearchWhere(search, projectId, dateIntervalInDays)
      : buildSessionSearchWhere(search);
  }
  if (filters?.length) {
    Object.assign(sb.where, getEventFiltersWhereClause(filters));
  }

  if (onlyReplays) {
    // Keep only sessions with a replay recording, within the same date window.
    sb.where.hasReplay = buildHasReplayWhere(projectId, dateIntervalInDays);
    // Hide trivial/empty recordings (PostHog defaults to > 5s).
    sb.where.minDuration = `duration >= ${MIN_REPLAY_DURATION_MS}`;
    if (replaySessionFilters?.length) {
      Object.assign(sb.where, buildReplaySessionFilterWhere(replaySessionFilters));
    }
  }

  // Behavior filters (PostHog-style): keep sessions that fired the selected
  // event(s) and/or matched the event-property filters — one events subquery.
  if (replayEventNames?.length || replayEventFilters?.length) {
    sb.where.replayBehavior = buildReplayBehaviorWhere(
      projectId,
      dateIntervalInDays,
      replayEventNames,
      replayEventFilters,
    );
  }

  // One row per session. FINAL alone doesn't guarantee it on this
  // VersionedCollapsingMergeTree: orphan sign=-1 rows and several un-collapsed
  // versions survive, and a session id revived by the SDK after its Redis state
  // expired gets a second row with a new created_at (sort key). Keep the live
  // (+1), newest version of each id — same semantics as getSessionsCount.
  sb.where.sign = 'sign = 1';
  sb.limitBy = '1 BY id';

  // ==== Select columns (as you had) ====
  // sb.select.id = 'id'; sb.select.project_id = 'project_id'; ... etc.
  const columns = [
    'created_at',
    'ended_at',
    'id',
    'profile_id',
    'entry_path',
    'exit_path',
    'duration',
    'is_bounce',
    'referrer_name',
    'referrer',
    'country',
    'city',
    'os',
    'browser',
    'brand',
    'model',
    'device',
    'screen_view_count',
    'event_count',
    'revenue',
  ];

  columns.forEach((column) => {
    sb.select[column] = column;
  });

  // Replay-aware path: sorting by recording duration / event count, or bounding
  // the recording duration, needs each candidate's replay active time in SQL.
  // Computed exactly (same formula as the player) for the filtered candidates
  // in one query (~1s for all of frameo's 14 days), offset-paginated.
  const replayAware =
    onlyReplays &&
    (replaySort !== 'newest' ||
      minReplayDurationMs !== undefined ||
      maxReplayDurationMs !== undefined);

  let data: IClickhouseSession[];
  let meta: PageInfo;
  let precomputed: Map<string, SessionReplayDuration> | undefined;

  if (replayAware) {
    sb.where.created_at = `created_at > now() - INTERVAL ${dateIntervalInDays} DAY`;
    const where = getWhere();
    const offset = Math.max(0, cursor?.offset ?? 0);
    const hasDurBounds =
      minReplayDurationMs !== undefined || maxReplayDurationMs !== undefined;
    // Replay duration is needed only to sort or bound by it. "Most events"
    // sorts on a sessions column, so it never touches the chunks table — and so
    // keeps sessions whose chunks now live only in the Blob archive.
    const needsDuration = replaySort === 'duration' || hasDurBounds;
    const latestSessions = `SELECT ${columns.join(', ')}
         FROM ${TABLE_NAMES.sessions} FINAL
         ${where}
         ORDER BY created_at DESC, version DESC
         LIMIT 1 BY id`;

    let rows: (IClickhouseSession & {
      replay_ms?: string;
      replay_tabs?: string;
    })[];
    if (!needsDuration) {
      rows = await chQuery<IClickhouseSession>(
        `SELECT * FROM (${latestSessions}) AS s
         ORDER BY ${replaySort === 'events' ? 's.event_count DESC' : 's.created_at DESC'}, s.id
         LIMIT ${take} OFFSET ${offset}`,
      );
    } else {
      const durBounds = [
        minReplayDurationMs !== undefined
          ? `d.dur >= ${Math.floor(minReplayDurationMs)}`
          : '',
        maxReplayDurationMs !== undefined
          ? `d.dur <= ${Math.floor(maxReplayDurationMs)}`
          : '',
      ].filter(Boolean);
      // Duration bounds need a measurable duration, so they INNER JOIN the CH
      // chunks (getSessionsCount applies the same rule — list and count agree).
      // "Longest" without bounds LEFT JOINs: archived-only sessions (no CH
      // chunks, d.tabs = 0) stay listed, sorted last, and get their shown
      // duration from the archive via batchSessionReplayDuration below.
      const durRows = await replayDurationRowsSource(
        projectId,
        `project_id = ${sqlstring.escape(projectId)}
                  AND started_at > now() - INTERVAL ${dateIntervalInDays + 1} DAY
                  AND session_id IN (SELECT id FROM ${TABLE_NAMES.sessions} ${where})`,
        dateIntervalInDays + 1,
      );
      rows = await chQuery<
        IClickhouseSession & { replay_ms: string; replay_tabs: string }
      >(
        `SELECT s.*, toString(d.dur) AS replay_ms, toString(d.tabs) AS replay_tabs
         FROM (${latestSessions}) AS s
         ${hasDurBounds ? 'INNER JOIN' : 'LEFT JOIN'} (
           SELECT session_id, sum(active_ms) AS dur, count() AS tabs
           FROM (
             SELECT session_id, window_id, ${replayActiveMsExpr} AS active_ms
             FROM (
               ${replayWindowRowsSql(
                 durRows.from,
                 durRows.where,
                 'session_id, window_id',
               )}
             )
             GROUP BY session_id, window_id
           )
           GROUP BY session_id
         ) AS d ON d.session_id = s.id
         ${durBounds.length ? `WHERE ${durBounds.join(' AND ')}` : ''}
         ORDER BY ${replaySort === 'duration' ? '(d.tabs = 0), d.dur DESC' : replaySort === 'events' ? 's.event_count DESC' : 's.created_at DESC'}, s.id
         LIMIT ${take} OFFSET ${offset}`,
      );
      precomputed = new Map(
        rows
          .filter((r) => Number(r.replay_tabs) > 0)
          .map((r) => [
            r.id,
            {
              durationMs: Math.max(0, Number(r.replay_ms)),
              tabCount: Number(r.replay_tabs),
            },
          ]),
      );
    }
    data = rows;
    meta = {
      next:
        rows.length === take
          ? { createdAt: '', id: '', offset: offset + take }
          : undefined,
    };
  } else {
    if (cursor?.createdAt) {
      const cAt = sqlstring.escape(cursor.createdAt);
      sb.where.cursor = `created_at < toDateTime64(${cAt}, 3)`;
      sb.where.cursorWindow = `created_at >= toDateTime64(${cAt}, 3) - INTERVAL ${dateIntervalInDays} DAY`;
    } else {
      sb.where.created_at = `created_at > now() - INTERVAL ${dateIntervalInDays} DAY`;
    }
    sb.orderBy.created_at = 'created_at DESC';
    sb.orderBy.version = 'version DESC';

    data = await chQuery<IClickhouseSession>(getSql());

    // Compute cursors from page edges
    const last = data[take - 1];
    meta = {
      next: last
        ? {
            createdAt: last.created_at,
            id: last.id,
          }
        : undefined,
    };
  }

  // Profile hydration (unchanged)
  const profileIds = Array.from(new Set(data.map((e) => e.profile_id)));
  const profiles = await getProfilesCached(profileIds, projectId);
  const map = new Map<string, IServiceProfile>(profiles.map((p) => [p.id, p]));

  const sessionIds = data.map((s) => s.id);
  // Durations already computed in SQL are reused; the rest (fast path, "Most
  // events", archived-only rows) come from batchSessionReplayDuration, which
  // falls back to the Blob archive.
  const needDurations = onlyReplays
    ? sessionIds.filter((id) => !precomputed?.has(id))
    : [];
  const [replaySet, fetchedDurations] = await Promise.all([
    batchSessionHasReplay(sessionIds, projectId),
    needDurations.length
      ? batchSessionReplayDuration(needDurations, projectId)
      : Promise.resolve(undefined),
  ]);
  const replayDurations = onlyReplays
    ? new Map([...(fetchedDurations ?? []), ...(precomputed ?? [])])
    : undefined;

  const items = data.map(transformSession).map((item) => ({
    ...item,
    hasReplay: replaySet.has(item.id),
    // On the replays list, show the RECORDING length — the same idle-collapsed
    // time the player's readout shows, summed over the session's tabs — not
    // the tracked-event span.
    duration: replayDurations?.get(item.id)?.durationMs ?? item.duration,
    replayTabCount: replayDurations?.get(item.id)?.tabCount,
    profile: map.get(item.profileId) ?? {
      id: item.profileId,
      email: '',
      avatar: '',
      firstName: '',
      lastName: '',
      createdAt: new Date(),
      projectId,
      isExternal: false,
      properties: {},
    },
  }));

  return { items, meta };
}

export async function getSessionsCount({
  projectId,
  profileId,
  filters,
  startDate,
  endDate,
  search,
  onlyReplays,
  replayEventNames,
  replayEventFilters,
  replaySessionFilters,
  replayDays,
  minReplayDurationMs,
  maxReplayDurationMs,
}: Omit<GetSessionListOptions, 'take' | 'cursor' | 'replaySort'>) {
  const { sb, getSql, getWhere } = createSqlBuilder();

  // uniqExact(id) — count DISTINCT sessions. `count(*) WHERE sign=1` over-counts
  // a VersionedCollapsingMergeTree by the number of un-merged session versions.
  sb.select.count = 'uniqExact(id) as count';
  sb.where.projectId = `project_id = ${sqlstring.escape(projectId)}`;
  sb.where.sign = 'sign = 1';

  const days = onlyReplays
    ? (clampReplayDays(replayDays) ?? (await getReplayLookbackDays(projectId)))
    : await getSessionLookbackDays(projectId);

  if (onlyReplays) {
    sb.where.hasReplay = buildHasReplayWhere(projectId, days);
    // Hide trivial/empty recordings (PostHog defaults to > 5s). Half of dashreels
    // replay sessions are < 5s (0:00 rows) and just pad the count.
    sb.where.minDuration = `duration >= ${MIN_REPLAY_DURATION_MS}`;
    if (replaySessionFilters?.length) {
      Object.assign(sb.where, buildReplaySessionFilterWhere(replaySessionFilters));
    }
  }

  if (profileId) {
    sb.where.profileId = `profile_id = ${sqlstring.escape(profileId)}`;
  }

  if (startDate && endDate) {
    sb.where.created_at = `toDate(created_at) BETWEEN toDate('${formatClickhouseDate(startDate)}') AND toDate('${formatClickhouseDate(endDate)}')`;
  }

  if (search) {
    sb.where.search = onlyReplays
      ? buildReplaySearchWhere(search, projectId, days)
      : buildSessionSearchWhere(search);
  }

  if (replayEventNames?.length || replayEventFilters?.length) {
    sb.where.replayBehavior = buildReplayBehaviorWhere(
      projectId,
      days,
      replayEventNames,
      replayEventFilters,
    );
  }

  if (filters && filters.length > 0) {
    const sessionFilters = getEventFiltersWhereClause(filters);
    sb.where = {
      ...sb.where,
      ...sessionFilters,
    };
  }

  sb.from = TABLE_NAMES.sessions;

  // Recording-duration bounds need the replay active time per candidate.
  if (
    onlyReplays &&
    (minReplayDurationMs !== undefined || maxReplayDurationMs !== undefined)
  ) {
    const where = getWhere();
    const bounds = [
      minReplayDurationMs !== undefined
        ? `dur >= ${Math.floor(minReplayDurationMs)}`
        : '',
      maxReplayDurationMs !== undefined
        ? `dur <= ${Math.floor(maxReplayDurationMs)}`
        : '',
    ].filter(Boolean);
    const durRows = await replayDurationRowsSource(
      projectId,
      `project_id = ${sqlstring.escape(projectId)}
                AND started_at > now() - INTERVAL ${days + 1} DAY
                AND session_id IN (SELECT id FROM ${TABLE_NAMES.sessions} ${where})`,
      days + 1,
    );
    const rows = await chQuery<{ count: number }>(
      `SELECT count() AS count FROM (
         SELECT session_id, sum(active_ms) AS dur
         FROM (
           SELECT session_id, window_id, ${replayActiveMsExpr} AS active_ms
           FROM (
             ${replayWindowRowsSql(
               durRows.from,
               durRows.where,
               'session_id, window_id',
             )}
           )
           GROUP BY session_id, window_id
         )
         GROUP BY session_id
         HAVING ${bounds.join(' AND ')}
       )`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  const result = await chQuery<{ count: number }>(getSql());
  return result[0]?.count ?? 0;
}

export const getSessionsCountCached = cacheable(getSessionsCount, 60 * 10);

class SessionService {
  constructor(private client: typeof ch) {}

  async byId(sessionId: string, projectId: string) {
    const result = await clix(this.client)
      .select<IClickhouseSession>(['*'])
      .from(TABLE_NAMES.sessions)
      .where('id', '=', sessionId)
      .where('project_id', '=', projectId)
      .where('sign', '=', 1)
      .execute();

    if (!result[0]) {
      throw new Error('Session not found');
    }

    const session = transformSession(result[0]);
    const profiles = await getProfilesCached([session.profileId], projectId);
    return { ...session, profile: profiles[0] };
  }
}

export const sessionService = new SessionService(ch);

const REPLAY_CHUNKS_PAGE_SIZE = 50;

type ReplayChunkRow = {
  chunk_index: number;
  payload: string;
  chunk_started_at: string;
  chunk_ended_at: string;
};

type ReplayChunkItem = {
  chunkIndex: number;
  startedAtMs: number;
  endedAtMs: number;
  events: { type: number; data: unknown; timestamp: number }[];
};

function transformReplayChunkRow(
  row: ReplayChunkRow,
  chunkIndex: number,
): ReplayChunkItem {
  let events: { type: number; data: unknown; timestamp: number }[] = [];
  try {
    events = JSON.parse(row.payload);
  } catch {
    events = [];
  }
  return {
    chunkIndex,
    startedAtMs: new Date(row.chunk_started_at).getTime(),
    endedAtMs: new Date(row.chunk_ended_at).getTime(),
    events,
  };
}

// --- Replay serving source (ClickHouse hot table vs archived Azure Blob) ---
const REPLAY_BLOB_CONN = process.env.AZURE_BLOB_CONNECTION_STRING || '';
const REPLAY_BLOB_CONTAINER =
  process.env.REPLAY_ARCHIVE_CONTAINER || 'clickhouse-export';
// Serving is "ch-first" by default: read from the ClickHouse hot table while it
// still holds the session (recent, fast seeks), and fall back to the archived
// Azure Blob only for sessions CH has evicted (old/deleted).
// AZURE_BLOB_CONNECTION_STRING is the on/off: unset it and serving is CH-only
// (the deploy-free kill switch if the Blob path ever misbehaves).
//
// REPLAY_SERVE_BLOB_FIRST=true flips it to "blob-first": serve from the archive
// whenever the session IS archived, even if CH still has it — so the blob path
// can be validated across ALL archived sessions before deleting the CH copies.
// Not-yet-archived (recent) sessions still fall back to CH. Off in prod.
const REPLAY_SERVE_BLOB_FIRST = process.env.REPLAY_SERVE_BLOB_FIRST === 'true';
const REPLAY_ARCHIVE_INDEX = 'replay_archive_index';
const replayLogger = createLogger({ name: 'replay-serving' });

export type ReplaySource = {
  /** Which store this read hits — 'blob' (Azure) or 'ch' (ClickHouse hot). */
  kind: 'blob' | 'ch';
  /** FROM-clause expression: a table name or an azureBlobStorage(...) call. */
  from: string;
  /** Extra settings for this read (blob reads must disable hive partitioning). */
  settings?: ClickHouseSettings;
};

const CH_REPLAY_SOURCE: ReplaySource = {
  kind: 'ch',
  from: TABLE_NAMES.session_replay_chunks,
};

/** Does the CH hot table still have any chunk for this session? */
async function chHasSession(
  sessionId: string,
  projectId: string,
): Promise<boolean> {
  const rows = await chQuery<{ one: number }>(
    `SELECT 1 AS one FROM ${TABLE_NAMES.session_replay_chunks}
      WHERE project_id = ${sqlstring.escape(projectId)}
        AND session_id = ${sqlstring.escape(sessionId)}
      LIMIT 1`,
  );
  return rows.length > 0;
}

/** Exact blob path(s) for a session — usually one; two if it crossed midnight. */
async function blobPathsForSession(
  sessionId: string,
  projectId: string,
): Promise<string[]> {
  const rows = await chQuery<{ blob_path: string }>(
    `SELECT DISTINCT blob_path FROM ${REPLAY_ARCHIVE_INDEX} FINAL
      WHERE project_id = ${sqlstring.escape(projectId)}
        AND session_id = ${sqlstring.escape(sessionId)}`,
  );
  return rows.map((r) => r.blob_path).filter(Boolean);
}

/**
 * Resolve where to read a session's replay chunks from. The blob is a `SELECT *`
 * dump of the table, so every column/filter used on the CH table works unchanged
 * on the blob — only the FROM expression and the hive-partitioning setting
 * differ. Blob reads target the exact blob path(s) (two for a midnight-crossing
 * session, via brace expansion).
 */
async function resolveReplaySource(
  sessionId: string,
  projectId: string,
): Promise<ReplaySource> {
  // No blob configured → CH-only (also the deploy-free kill switch).
  if (!REPLAY_BLOB_CONN) {
    return CH_REPLAY_SOURCE;
  }
  // Default (ch-first): prefer CH while it still has the session (recent, fast
  // seeks); only fall to the Blob archive for sessions CH has evicted. In
  // blob-first test mode we skip this and go straight to the archive, so blob
  // serving can be exercised on sessions CH still holds.
  if (!REPLAY_SERVE_BLOB_FIRST && (await chHasSession(sessionId, projectId))) {
    return CH_REPLAY_SOURCE;
  }
  // CH evicted it (default), or blob-first test mode → serve from the archive if
  // present; not-yet-archived (recent) sessions have no blob and fall back to CH.
  const paths = await blobPathsForSession(sessionId, projectId);
  if (paths.length === 0) {
    return CH_REPLAY_SOURCE; // not archived (very recent) — serve from CH
  }
  const pathArg = paths.length === 1 ? paths[0]! : `{${paths.join(',')}}`;
  replayLogger.info('serving replay from Azure Blob', {
    sessionId,
    projectId,
    source: 'blob',
    blobCount: paths.length,
    blobPaths: paths,
  });
  return {
    kind: 'blob',
    from: `azureBlobStorage(${sqlstring.escape(REPLAY_BLOB_CONN)}, ${sqlstring.escape(REPLAY_BLOB_CONTAINER)}, ${sqlstring.escape(pathArg)}, 'Native', 'zstd')`,
    settings: { use_hive_partitioning: 0 },
  };
}

// --- Blob-primary blocks serving (REPLAY_SERVE_BLOCKS_PROJECT_IDS) ---
// One source per session, never mixed (PostHog's rule). For an allow-listed
// project a session is served from the Azure blocks ('blocks') only when its
// blocks are provably complete, BOTH:
//   (a) every ref was written at/after REPLAY_BLOCKS_COMPLETE_SINCE (the
//       dual-write rollout had finished, so no chunk was consumed by a
//       not-yet-dual pod: excludes rollout-window gaps); AND
//   (b) the legacy stores hold NO chunk older than the blocks' first chunk
//       (min first_started_at): a long-lived session that recorded before
//       blocks existed and resumed later has refs that pass (a) but only its
//       tail in blocks. Strict `<`: complete sessions have equal first
//       timestamps, and both come from the same device clock.
// Every other session (no refs, (a) or (b) failing, or the (b) guard query
// erroring, fail safe) takes the legacy path unchanged (CH-first, else cold
// archive); CH/archive were dual-written for the whole blocks period, so they
// are complete for those. The decision lives in decideReplayServing() and is
// shared by the block-list endpoint (replay-block-list.ts) and the chunk
// readers below.
//
// Cancellation: a read whose client went away (AbortError, or the caller's
// signal fired) just stops. It is never treated as a store failure, so it never
// falls back to legacy (that used to turn every cancelled page into a 33 MB
// ClickHouse read).
//
// The chunk readers (replayChunksFrom / ByIndexRange / AroundTime, kept for the
// MCP / agent callers) still need a per-chunk index for 'blocks'; with no
// `chunk_keys` column that means decoding every block once (cached). The
// dashboard player no longer uses them: it reads the block list + raw blocks
// (replay-block-list.ts), which never decodes on the server.

export type ReplayServingDecision =
  | { kind: 'blocks'; refs: ReplayBlockRef[] }
  | { kind: 'ch' | 'blob'; legacy: ReplaySource };

type ResolvedReplay =
  | { kind: 'ch' | 'blob'; legacy: ReplaySource }
  | { kind: 'blocks'; index: ReplayIndexRow[] };

type BlocksResolved = Extract<ResolvedReplay, { kind: 'blocks' }>;

function isBlocksResolved(r: ResolvedReplay): r is BlocksResolved {
  return r.kind === 'blocks';
}

// Guard (b) results, keyed by the ref set (count + max block_index) so a live
// session's new block is a cache miss. Guard failures are never cached.
const GUARD_TTL_MS = 30 * 1000;
const GUARD_CACHE_MAX = 500;
const guardCache = new Map<string, { at: number; complete: boolean }>();

function cacheGuard(key: string, complete: boolean) {
  if (guardCache.size >= GUARD_CACHE_MAX) {
    const oldest = guardCache.keys().next().value;
    if (oldest !== undefined) guardCache.delete(oldest);
  }
  guardCache.set(key, { at: Date.now(), complete });
}

// The per-chunk index built from a 'blocks' session's refs (chunk readers
// only). Same key as the guard cache.
const BLOCK_INDEX_TTL_MS = 30 * 1000;
const BLOCK_INDEX_MAX = 200;
const blockIndexCache = new Map<
  string,
  { at: number; index: ReplayIndexRow[] }
>();

function cacheBlockIndex(key: string, index: ReplayIndexRow[]) {
  if (blockIndexCache.size >= BLOCK_INDEX_MAX) {
    const oldest = blockIndexCache.keys().next().value;
    if (oldest !== undefined) blockIndexCache.delete(oldest);
  }
  blockIndexCache.set(key, { at: Date.now(), index });
}

function refSetKey(
  projectId: string,
  sessionId: string,
  refs: ReplayBlockRef[],
): string {
  let maxBlock = 0;
  for (const r of refs) maxBlock = Math.max(maxBlock, r.blockIndex);
  return [projectId, sessionId, refs.length, maxBlock].join('\u0000');
}

/**
 * Completeness guard (b): does the legacy store (CH hot chunks, or the cold
 * archive index) hold any chunk of this session that started strictly before
 * the blocks' first chunk? Two point lookups on the sort-key prefix.
 */
async function legacyHasOlderReplay(
  sessionId: string,
  projectId: string,
  blocksFirstMs: number,
): Promise<boolean> {
  const sid = sqlstring.escape(sessionId);
  const proj = sqlstring.escape(projectId);
  const before = `fromUnixTimestamp64Milli(toInt64(${Math.floor(blocksFirstMs)}))`;
  const chunks = `SELECT 1 AS older
     FROM ${TABLE_NAMES.session_replay_chunks}
     WHERE project_id = ${proj}
       AND session_id = ${sid}
       AND started_at < ${before}
     LIMIT 1`;
  const sql = REPLAY_BLOB_CONN
    ? `${chunks}
     UNION ALL
     SELECT 1 AS older
     FROM ${REPLAY_ARCHIVE_INDEX} FINAL
     WHERE project_id = ${proj}
       AND session_id = ${sid}
       AND first_started_at < ${before}
     LIMIT 1`
    : chunks;
  const rows = await chQuery<{ older: number }>(sql);
  return rows.length > 0;
}

/**
 * Completeness guard (c): while ClickHouse still holds this session, is there a
 * chunk in CH that the blocks don't have? That catches what (b) cannot: chunks
 * missing AFTER the blocks' first chunk (a failed dual-write shadow append
 * mid-session) and a tab that exists only in CH.
 *
 * - A tab whose refs all carry `chunk_keys` compares SETS of
 *   (chunk_index, started_ms): duplicated blocks (redelivered batches) can't
 *   mask a missing chunk, and counts can't cancel out. Refs from before
 *   migration 26 fall back to summed events_count, where a duplicate can.
 * - In flight is not missing: dual-write inserts CH chunks before the shadow
 *   block write of the same batch, so a live tab briefly has CH chunks the
 *   blocks don't. A CH chunk newer than the tab's newest block is ignored
 *   while that tab's newest block was WRITTEN less than
 *   REPLAY_GUARD_INFLIGHT_GRACE_MS ago (ref created_at: ClickHouse server
 *   time, set in the same consumer batch as the CH insert). Measuring from
 *   the browser's started_at instead would flip live sessions to legacy
 *   during a Kafka backlog and let a fast visitor clock hide a missing tail.
 *   Once the tab's blocks stop advancing for the grace, a missing tail is a
 *   real gap. A tab with no refs at all uses the session's newest ref.
 *
 * Reads key columns + events_count only, on the (project_id, session_id)
 * sort-key prefix. Sessions CH has already dropped are not checked here (the
 * archive index has no per-chunk data).
 */
const REPLAY_GUARD_INFLIGHT_GRACE_MS = 2 * 60 * 1000;

async function chHasChunksMissingFromBlocks(
  sessionId: string,
  projectId: string,
  refs: ReplayBlockRef[],
  nowMs: number = Date.now(),
): Promise<boolean> {
  const rows = await chQuery<{
    window_id: string;
    ms: string;
    chunk_index: number;
    ev: number;
  }>(
    `SELECT window_id, chunk_index,
            toString(toUnixTimestamp64Milli(started_at)) AS ms,
            any(events_count) AS ev
     FROM ${TABLE_NAMES.session_replay_chunks}
     WHERE project_id = ${sqlstring.escape(projectId)}
       AND session_id = ${sqlstring.escape(sessionId)}
     GROUP BY window_id, chunk_index, started_at`,
  );
  if (rows.length === 0) return false;

  const byWindow = new Map<
    string,
    {
      keys: Set<string>;
      allKeyed: boolean;
      events: number;
      lastMs: number;
      lastWrittenMs: number;
    }
  >();
  let sessionLastWrittenMs = Number.NEGATIVE_INFINITY;
  for (const r of refs) {
    const w = byWindow.get(r.windowId) ?? {
      keys: new Set<string>(),
      allKeyed: true,
      events: 0,
      lastMs: Number.NEGATIVE_INFINITY,
      lastWrittenMs: Number.NEGATIVE_INFINITY,
    };
    w.events += r.eventsCount;
    w.lastMs = Math.max(w.lastMs, r.lastStartedMs);
    w.lastWrittenMs = Math.max(w.lastWrittenMs, r.createdAtMs);
    sessionLastWrittenMs = Math.max(sessionLastWrittenMs, r.createdAtMs);
    if (r.chunkKeys.length === 0) w.allKeyed = false;
    for (const [chunkIndex, startedMs] of r.chunkKeys) {
      w.keys.add(`${chunkIndex}:${startedMs}`);
    }
    byWindow.set(r.windowId, w);
  }

  const chEvents = new Map<string, number>();
  for (const row of rows) {
    const startedMs = Number(row.ms);
    const w = byWindow.get(row.window_id);
    const inFlight =
      startedMs > (w?.lastMs ?? Number.NEGATIVE_INFINITY) &&
      nowMs - (w?.lastWrittenMs ?? sessionLastWrittenMs) <
        REPLAY_GUARD_INFLIGHT_GRACE_MS;
    if (inFlight) continue;
    if (!w) return true; // a tab only CH has
    if (w.allKeyed) {
      if (!w.keys.has(`${Number(row.chunk_index)}:${startedMs}`)) return true;
    } else {
      chEvents.set(
        row.window_id,
        (chEvents.get(row.window_id) ?? 0) + Number(row.ev),
      );
    }
  }
  for (const [windowId, events] of chEvents) {
    if (events > byWindow.get(windowId)!.events) return true;
  }
  return false;
}

/**
 * Are this session's refs a complete copy (rules (a) + (b) + (c))? A guard
 * query failure is fail safe (false, not cached, so the next read retries);
 * a cancellation is rethrown.
 */
async function blocksAreComplete(
  sessionId: string,
  projectId: string,
  refs: ReplayBlockRef[],
  signal?: AbortSignal | null,
): Promise<boolean> {
  if (refs.length === 0) return false;
  let minCreated = Number.POSITIVE_INFINITY;
  let blocksFirstMs = Number.POSITIVE_INFINITY;
  for (const r of refs) {
    minCreated = Math.min(minCreated, r.createdAtMs);
    blocksFirstMs = Math.min(blocksFirstMs, r.firstStartedMs);
  }
  // (a) a ref written before COMPLETE_SINCE: possible rollout gap, legacy.
  if (minCreated < REPLAY_BLOCKS_COMPLETE_SINCE_MS) return false;
  if (!Number.isFinite(blocksFirstMs)) return false;

  const key = refSetKey(projectId, sessionId, refs);
  const hit = guardCache.get(key);
  if (hit && Date.now() - hit.at < GUARD_TTL_MS) return hit.complete;

  // (b) legacy holds chunks older than the blocks: the blocks are only the
  // tail of a resumed session, legacy.
  // (c) CH holds a chunk the blocks don't: a gap inside the session (failed
  // shadow write) or a CH-only tab, legacy.
  // A guard query failure is not cached and is rethrown: decideReplayServing
  // then serves legacy only when legacy actually has the session.
  let older: boolean;
  try {
    older =
      (await legacyHasOlderReplay(sessionId, projectId, blocksFirstMs)) ||
      (await chHasChunksMissingFromBlocks(sessionId, projectId, refs));
  } catch (error) {
    if (isReplayAbortError(error, signal)) throw error;
    replayLogger.error('replay blocks completeness guard failed', {
      sessionId,
      projectId,
      error,
    });
    throw error;
  }
  cacheGuard(key, !older);
  return !older;
}

/** A transient failure deciding where a replay lives (retry, not "none"). */
export class ReplayTemporarilyUnavailableError extends Error {
  readonly status = 503;
  // Fastify's error handler reads statusCode.
  readonly statusCode = 503;
  constructor(message: string) {
    super(message);
    this.name = 'ReplayTemporarilyUnavailableError';
  }
}

/**
 * THE source decision for a session's replay: 'blocks' (allow-listed project,
 * complete refs) with its refs, else the legacy CH-first-else-archive source.
 * A failure while looking at blocks (CH ref read) is logged and serves legacy;
 * a cancellation is rethrown, never turned into a fallback.
 */
export async function decideReplayServing(
  sessionId: string,
  projectId: string,
  opts: { signal?: AbortSignal | null } = {},
): Promise<ReplayServingDecision> {
  if (isReplayBlocksServingEnabled(projectId)) {
    let refs: ReplayBlockRef[] | null = null;
    try {
      refs = await fetchReplayBlockRefs(projectId, sessionId);
      if (await blocksAreComplete(sessionId, projectId, refs, opts.signal)) {
        return { kind: 'blocks', refs };
      }
    } catch (error) {
      if (isReplayAbortError(error, opts.signal)) throw error;
      replayLogger.error('replay blocks resolve failed; serving legacy', {
        sessionId,
        projectId,
        error,
      });
      // Legacy is only a fallback if it has the session. A Blob-only
      // project's session (or one CH has dropped) has nothing there, and
      // serving that would show "no replay" for a recording that exists:
      // fail retryably instead. (Archived pre-blocks sessions have no refs,
      // so they still reach the archive below.)
      if (
        (refs === null || refs.length > 0) &&
        !(await chHasSession(sessionId, projectId))
      ) {
        throw new ReplayTemporarilyUnavailableError(
          'replay storage check failed; retry',
        );
      }
    }
  }
  const legacy = await resolveReplaySource(sessionId, projectId);
  return { kind: legacy.kind, legacy };
}

/**
 * The chunk readers' resolution: the decision plus, for 'blocks', the
 * session's chunk index (from `chunk_keys`, else by decoding the blocks once).
 * A failure building the index is logged and serves legacy; a cancellation is
 * rethrown.
 */
async function resolveReplay(
  sessionId: string,
  projectId: string,
  signal?: AbortSignal | null,
): Promise<ResolvedReplay> {
  const decision = await decideReplayServing(sessionId, projectId, { signal });
  if (decision.kind !== 'blocks') {
    return { kind: decision.kind, legacy: decision.legacy };
  }
  const key = refSetKey(projectId, sessionId, decision.refs);
  const hit = blockIndexCache.get(key);
  if (hit && Date.now() - hit.at < BLOCK_INDEX_TTL_MS) {
    return { kind: 'blocks', index: hit.index };
  }
  try {
    const index = buildReplayIndex(
      await resolveReplayRefKeys(decision.refs, { signal }),
    );
    if (index.length > 0) {
      cacheBlockIndex(key, index);
      return { kind: 'blocks', index };
    }
  } catch (error) {
    if (isReplayAbortError(error, signal)) throw error;
    replayLogger.error('replay blocks index failed; serving legacy', {
      sessionId,
      projectId,
      error,
    });
  }
  return resolveLegacyReplay(sessionId, projectId);
}

async function resolveLegacyReplay(
  sessionId: string,
  projectId: string,
): Promise<Extract<ResolvedReplay, { kind: 'ch' | 'blob' }>> {
  const legacy = await resolveReplaySource(sessionId, projectId);
  return { kind: legacy.kind, legacy };
}

/**
 * The blocks session's ordered keys for a read scope, or null when the scope
 * has no keys in blocks (e.g. a window the blocks don't hold): the caller
 * then serves that read from legacy.
 */
function blocksScopeKeys(
  r: BlocksResolved,
  windowId: string | undefined,
): ReplayScopedKey[] | null {
  const keys = scopeReplayKeys(r.index, windowId);
  return keys.length > 0 ? keys : null;
}

function blockChunkToItem(c: ReplayBlockChunk): ReplayChunkItem {
  let events: ReplayChunkItem['events'] = [];
  try {
    events = JSON.parse(c.payload);
  } catch {
    events = [];
  }
  return {
    chunkIndex: c.seq,
    startedAtMs: c.startedMs,
    endedAtMs: c.endedMs,
    events,
  };
}

/**
 * Payloads for a page of scoped keys from blocks. Returns null when the page
 * wanted chunks but none could be read (Blob error, or blocks missing them) so
 * the caller falls back to legacy for this read; a partial page is logged. A
 * cancellation is rethrown: it must never trigger the legacy fallback.
 */
async function loadBlocksPage(
  sessionId: string,
  projectId: string,
  windowId: string | undefined,
  keys: ReplayScopedKey[],
  signal?: AbortSignal | null,
): Promise<ReplayChunkItem[] | null> {
  if (keys.length === 0) return [];
  let chunks: Map<number, ReplayBlockChunk>;
  try {
    chunks = await loadReplayChunksFromBlocks(keys, windowId, { signal });
  } catch (error) {
    if (isReplayAbortError(error, signal)) throw error;
    replayLogger.error('replay blocks page read failed; serving legacy', {
      sessionId,
      projectId,
      windowId,
      error,
    });
    return null;
  }
  if (chunks.size === 0) return null;
  if (chunks.size < keys.length) {
    replayLogger.warn('replay blocks page missing chunks', {
      sessionId,
      projectId,
      windowId,
      wanted: keys.length,
      found: chunks.size,
    });
  }
  return Array.from(chunks.values(), blockChunkToItem).sort(
    (a, b) => a.chunkIndex - b.chunkIndex,
  );
}

// --- Chunk ordering ---
// chunk_index is NOT unique within a window. The recorder restarts at 0
// whenever the host app stops/starts replay without a new window_id (frameo
// does it on every canvas route change), so one window holds several 0..N
// runs of *different* chunks — 8% of frameo's chunks. Keying on chunk_index
// (`LIMIT 1 BY chunk_index`) silently dropped all but one run. Chunks are
// instead ordered by (started_at, chunk_index) and served with a synthetic,
// contiguous `seq` — the index the player's buffer drains in order. Exact
// retries (same chunk_index AND started_at) collapse to one row.
// Works identically for the CH table and the Blob archive (same columns).

type ReplayChunkKey = { seq: number; chunk_index: number; started_ms: string };

function replayScope(
  sessionId: string,
  projectId: string,
  windowId?: string,
): string {
  return `session_id = ${sqlstring.escape(sessionId)}
       AND project_id = ${sqlstring.escape(projectId)}
       ${windowId !== undefined ? `AND window_id = ${sqlstring.escape(windowId)}` : ''}`;
}

/** Payload-free, deduped, time-ordered chunk keys with their `seq`. */
function replayChunkKeysSql(src: ReplaySource, scope: string): string {
  return `SELECT
         toUInt32(row_number() OVER (ORDER BY started_at, chunk_index) - 1) AS seq,
         chunk_index,
         toUnixTimestamp64Milli(started_at) AS started_ms,
         is_full_snapshot
       FROM (
         SELECT chunk_index, started_at, max(is_full_snapshot) AS is_full_snapshot
         FROM ${src.from}
         WHERE ${scope}
         GROUP BY chunk_index, started_at
       )`;
}

type ReplayChunkKeyFull = ReplayChunkKey & { is_full_snapshot: boolean };

// Archived (Blob) recordings never change, and every Blob query downloads and
// decompresses the whole session file — so a tab's key list (small: a few
// thousand rows) is cached briefly per process. Each page then needs ONE Blob
// read (payloads) instead of two. CH is live and cheap to key, so it's never
// cached.
const BLOB_KEYS_TTL_MS = 10 * 60 * 1000;
const BLOB_KEYS_MAX = 200;
const blobKeyCache = new Map<string, { at: number; keys: ReplayChunkKeyFull[] }>();

async function blobChunkKeys(
  src: ReplaySource,
  scope: string,
): Promise<ReplayChunkKeyFull[]> {
  const cacheKey = `${src.from}\u0000${scope}`;
  const hit = blobKeyCache.get(cacheKey);
  if (hit && Date.now() - hit.at < BLOB_KEYS_TTL_MS) return hit.keys;
  const rows = await chQuery<ReplayChunkKeyFull>(
    `SELECT seq, chunk_index, started_ms, is_full_snapshot
     FROM (${replayChunkKeysSql(src, scope)})
     ORDER BY seq`,
    src.settings,
  );
  const keys = rows.map((r) => ({
    seq: Number(r.seq),
    chunk_index: Number(r.chunk_index),
    started_ms: String(r.started_ms),
    is_full_snapshot: Boolean(r.is_full_snapshot),
  }));
  if (blobKeyCache.size >= BLOB_KEYS_MAX) {
    const oldest = blobKeyCache.keys().next().value;
    if (oldest !== undefined) blobKeyCache.delete(oldest);
  }
  blobKeyCache.set(cacheKey, { at: Date.now(), keys });
  return keys;
}

/** Load payloads for the given keys and return them as seq-indexed chunks. */
async function loadReplayChunksForKeys(
  src: ReplaySource,
  scope: string,
  keys: ReplayChunkKey[],
): Promise<ReplayChunkItem[]> {
  if (keys.length === 0) return [];
  const seqByKey = new Map(
    keys.map((k) => [`${k.chunk_index}:${k.started_ms}`, Number(k.seq)]),
  );
  const tuples = keys
    .map((k) => `(${Number(k.chunk_index)}, ${Number(k.started_ms)})`)
    .join(',');
  // Bound by the page's started_at range too. The tuple IN alone can't use the
  // (project_id, session_id, started_at, …) sort key, so ClickHouse decompressed
  // the tab's WHOLE payload column (1.2 GiB → 10.5s) to return 50 chunks; with
  // the range it reads only that page's granules (0.15–0.24s).
  const startedMs = keys.map((k) => Number(k.started_ms));
  const rangeFrom = Math.min(...startedMs);
  const rangeTo = Math.max(...startedMs);
  const rows = await chQuery<ReplayChunkRow & { started_ms: string }>(
    `SELECT chunk_index,
            payload,
            started_at AS chunk_started_at,
            ended_at AS chunk_ended_at,
            toUnixTimestamp64Milli(started_at) AS started_ms
     FROM ${src.from}
     WHERE ${scope}
       AND started_at >= fromUnixTimestamp64Milli(toInt64(${rangeFrom}))
       AND started_at <= fromUnixTimestamp64Milli(toInt64(${rangeTo}))
       AND (chunk_index, toUnixTimestamp64Milli(started_at)) IN (${tuples})
     ORDER BY started_at, chunk_index
     LIMIT 1 BY chunk_index, started_at`,
    src.settings,
  );
  return rows
    .map((row) =>
      transformReplayChunkRow(
        row,
        seqByKey.get(`${row.chunk_index}:${row.started_ms}`) ?? -1,
      ),
    )
    .filter((c) => c.chunkIndex >= 0)
    .sort((a, b) => a.chunkIndex - b.chunkIndex);
}

// --- Legacy (CH hot table / cold archive) reads for the block endpoints ---
// The block-list endpoint (replay-block-list.ts) serves legacy sessions as
// pseudo-blocks: fixed pages of the session's ordered chunk keys. These two
// helpers are its only legacy I/O: one payload-free key listing (all windows)
// and one payload read for the requested chunks, returned as NDJSON lines in
// the SAME format the Blob blocks store, so the player has one decode path.

export type LegacyReplayChunkKey = {
  windowId: string;
  chunkIndex: number;
  startedMs: number;
  endedMs: number;
  isFullSnapshot: boolean;
  eventsCount: number;
};

// Archived recordings never change and every archive query reads the whole
// session file, so the archive's key list is cached (like blobChunkKeys). The
// CH hot table is live and cheap to key: never cached here.
const legacyKeyCache = new Map<
  string,
  { at: number; keys: LegacyReplayChunkKey[] }
>();

/**
 * Every distinct chunk key of the session (all windows), de-duplicated by
 * (window_id, chunk_index, started_at) exactly like replayChunkKeysSql, ordered
 * by (started_at, chunk_index).
 */
export async function listLegacyReplayChunkKeys(
  src: ReplaySource,
  sessionId: string,
  projectId: string,
): Promise<LegacyReplayChunkKey[]> {
  const cacheKey = [src.from, sessionId, projectId].join('\u0000');
  if (src.kind === 'blob') {
    const hit = legacyKeyCache.get(cacheKey);
    if (hit && Date.now() - hit.at < BLOB_KEYS_TTL_MS) return hit.keys;
  }
  const rows = await chQuery<{
    window_id: string;
    chunk_index: string | number;
    s_ms: string | number;
    e_ms: string | number;
    full: string | number;
    ev: string | number;
  }>(
    `SELECT window_id,
            toString(chunk_index) AS chunk_index,
            toString(toUnixTimestamp64Milli(started_at)) AS s_ms,
            toString(max(toUnixTimestamp64Milli(ended_at))) AS e_ms,
            toString(max(toUInt8(is_full_snapshot))) AS full,
            toString(max(events_count)) AS ev
     FROM ${src.from}
     WHERE ${replayScope(sessionId, projectId)}
     GROUP BY window_id, chunk_index, started_at
     ORDER BY started_at, chunk_index`,
    src.settings,
  );
  const keys = rows.map((r) => {
    const startedMs = Number(r.s_ms);
    const endedMs = Number(r.e_ms);
    return {
      windowId: r.window_id ?? '',
      chunkIndex: Number(r.chunk_index),
      startedMs,
      endedMs: Number.isFinite(endedMs)
        ? Math.max(startedMs, endedMs)
        : startedMs,
      isFullSnapshot: Number(r.full) > 0,
      eventsCount: Number(r.ev) || 0,
    };
  });
  if (src.kind === 'blob') {
    if (legacyKeyCache.size >= BLOB_KEYS_MAX) {
      const oldest = legacyKeyCache.keys().next().value;
      if (oldest !== undefined) legacyKeyCache.delete(oldest);
    }
    legacyKeyCache.set(cacheKey, { at: Date.now(), keys });
  }
  return keys;
}

/** `${chunkIndex}:${startedMs}`: a chunk's identity within one window. */
export const legacyChunkId = (chunkIndex: number, startedMs: number) =>
  `${chunkIndex}:${startedMs}`;

/**
 * Payloads of the given chunks of one window, as block-format NDJSON lines
 * (`JSON.stringify` of the CH row, `payload` last), keyed by legacyChunkId.
 * Range-bounded on started_at so ClickHouse reads only those granules. The
 * signal aborts the ClickHouse request (client cancel).
 */
export async function readLegacyReplayChunkLines(
  src: ReplaySource,
  sessionId: string,
  projectId: string,
  windowId: string,
  keys: { chunkIndex: number; startedMs: number }[],
  opts: { signal?: AbortSignal | null } = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;
  const tuples = keys
    .map((k) => `(${Math.floor(k.chunkIndex)}, ${Math.floor(k.startedMs)})`)
    .join(',');
  const starts = keys.map((k) => Math.floor(k.startedMs));
  const res = await ch.query({
    query: `SELECT window_id,
            toString(chunk_index) AS chunk_index,
            toString(toUnixTimestamp64Milli(started_at)) AS s_ms,
            toString(toUnixTimestamp64Milli(ended_at)) AS e_ms,
            toString(events_count) AS events_count,
            toUInt8(is_full_snapshot) AS full,
            payload
     FROM ${src.from}
     WHERE ${replayScope(sessionId, projectId, windowId)}
       AND started_at >= fromUnixTimestamp64Milli(toInt64(${Math.min(...starts)}))
       AND started_at <= fromUnixTimestamp64Milli(toInt64(${Math.max(...starts)}))
       AND (chunk_index, toUnixTimestamp64Milli(started_at)) IN (${tuples})
     ORDER BY started_at, chunk_index
     LIMIT 1 BY chunk_index, started_at`,
    format: 'JSONEachRow',
    clickhouse_settings: src.settings,
    abort_signal: opts.signal ?? undefined,
  });
  const rows = await res.json<{
    window_id: string;
    chunk_index: string;
    s_ms: string;
    e_ms: string;
    events_count: string;
    full: number | string;
    payload: string;
  }>();
  for (const r of rows) {
    const startedMs = Number(r.s_ms);
    const endedMs = Number(r.e_ms);
    out.set(
      legacyChunkId(Number(r.chunk_index), startedMs),
      JSON.stringify({
        project_id: projectId,
        session_id: sessionId,
        window_id: r.window_id ?? '',
        chunk_index: Number(r.chunk_index),
        started_at: new Date(startedMs).toISOString(),
        ended_at: new Date(
          Number.isFinite(endedMs) ? endedMs : startedMs,
        ).toISOString(),
        events_count: Number(r.events_count) || 0,
        is_full_snapshot: Number(r.full) > 0,
        payload: r.payload ?? '',
      }),
    );
  }
  return out;
}

export async function getSessionReplayChunksFrom(
  sessionId: string,
  projectId: string,
  fromIndex: number,
  windowId?: string,
  opts: { signal?: AbortSignal | null } = {},
) {
  // When a windowId is supplied, scope chunks to that single recorder (one
  // tab), so the player never mixes rrweb mirror states across concurrent tabs.
  let resolved = await resolveReplay(sessionId, projectId, opts.signal);
  const from = Math.max(0, Math.floor(fromIndex));
  const to = from + REPLAY_CHUNKS_PAGE_SIZE + 1;
  if (isBlocksResolved(resolved)) {
    const all = blocksScopeKeys(resolved, windowId);
    if (all) {
      const page = all.filter((k) => k.seq >= from && k.seq < to);
      const data = await loadBlocksPage(
        sessionId,
        projectId,
        windowId,
        page.slice(0, REPLAY_CHUNKS_PAGE_SIZE),
        opts.signal,
      );
      if (data) {
        return { data, hasMore: page.length > REPLAY_CHUNKS_PAGE_SIZE };
      }
    }
    resolved = await resolveLegacyReplay(sessionId, projectId);
  }
  const src = resolved.legacy;
  const scope = replayScope(sessionId, projectId, windowId);
  const keys =
    src.kind === 'blob'
      ? (await blobChunkKeys(src, scope)).filter(
          (k) => k.seq >= from && k.seq < to,
        )
      : await chQuery<ReplayChunkKey>(
          `SELECT seq, chunk_index, started_ms
           FROM (${replayChunkKeysSql(src, scope)})
           WHERE seq >= ${from} AND seq < ${to}
           ORDER BY seq`,
          src.settings,
        );
  const items = await loadReplayChunksForKeys(
    src,
    scope,
    keys.slice(0, REPLAY_CHUNKS_PAGE_SIZE),
  );
  return {
    data: items,
    hasMore: keys.length > REPLAY_CHUNKS_PAGE_SIZE,
  };
}

// A recording's window_id is reused across reloads/idle, so its raw span is
// mostly dead air between chunks. Chunk gaps larger than this are treated as
// idle and collapsed on the scrubber (matches "skip idle" playback semantics).
// Shared by getSessionWindows (chip duration) and getSessionWindowSegments
// (scrubber) so the two always agree.
export const REPLAY_IDLE_GAP_MS = 15_000;

/**
 * THE replay duration definition — used by the tab chip, the player readout
 * (via getSessionWindowSegments, same merge rule) and the replays list, so the
 * three can never disagree again. Per window: wall-clock span minus every idle
 * gap (≥ REPLAY_IDLE_GAP_MS) between consecutive chunks.
 *
 * replayWindowRowsSql selects s_ms / e_ms / prev_e_ms rows; aggregate them
 * with replayActiveMsExpr.
 */
function replayWindowRowsSql(
  from: string,
  where: string,
  partitionBy: string,
  extraCols = '',
): string {
  return `SELECT ${partitionBy}${extraCols ? `, ${extraCols}` : ''},
         toUnixTimestamp64Milli(started_at) AS s_ms,
         toUnixTimestamp64Milli(ended_at) AS e_ms,
         -- Running max of earlier chunks' ends (not just the previous row's):
         -- restarted recorder runs overlap, and this is exactly how
         -- getSessionWindowSegments merges (last.endMs = max), so the totals match.
         max(toUnixTimestamp64Milli(ended_at)) OVER (
           PARTITION BY ${partitionBy} ORDER BY started_at, chunk_index
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ) AS prev_e_ms
       FROM ${from}
       WHERE ${where}`;
}
const replayActiveMsExpr = `greatest(0,
         (max(e_ms) - min(s_ms))
         - sum(if(prev_e_ms > 0 AND (s_ms - prev_e_ms) >= ${REPLAY_IDLE_GAP_MS}, s_ms - prev_e_ms, 0))
       )`;

/**
 * Row source for the replay-duration SQL (list sort/bounds, count, list
 * durations). Off / pre-migration-26 → the CH chunk table, unchanged. For a
 * blocks-served project with `chunk_keys`, the block refs' chunk keys are
 * UNION ALL'd in (ARRAY JOIN), so Blob-only sessions get a duration too. A
 * chunk present in both stores just repeats an identical (s_ms, e_ms) row,
 * which changes neither min/max nor the idle-gap sum nor the per-window count,
 * so no de-dup is needed here. `where` may use the chunk column names
 * (started_at, session_id, …) - the blocks branch aliases them.
 */
async function replayDurationRowsSource(
  projectId: string,
  where: string,
  /**
   * The lookback `where` applies to chunk started_at. On the blocks side
   * started_at only exists after the ARRAY JOIN, so it can't prune partitions;
   * the same bound on the real first_started_at column (one day of margin: a
   * block's first chunk can precede its others) lets ClickHouse skip them.
   */
  sinceDays?: number,
): Promise<{ from: string; where: string }> {
  if (
    !isReplayBlocksServingEnabled(projectId) ||
    !(await replayBlocksHaveChunkKeys())
  ) {
    return { from: TABLE_NAMES.session_replay_chunks, where };
  }
  return {
    from: `(
      SELECT project_id, session_id, window_id, chunk_index, started_at, ended_at, is_full_snapshot
      FROM ${TABLE_NAMES.session_replay_chunks}
      WHERE ${where}
      UNION ALL
      SELECT project_id, session_id, window_id,
             toUInt16(tupleElement(k, 1)) AS chunk_index,
             fromUnixTimestamp64Milli(tupleElement(k, 2)) AS started_at,
             fromUnixTimestamp64Milli(tupleElement(k, 3)) AS ended_at,
             toBool(tupleElement(k, 4)) AS is_full_snapshot
      FROM ${TABLE_NAMES.session_replay_blocks}
      ARRAY JOIN chunk_keys AS k
      WHERE ${where}${
        sinceDays !== undefined
          ? `
        AND first_started_at > now() - INTERVAL ${Math.floor(sinceDays) + 1} DAY`
          : ''
      }
    )`,
    where: '1',
  };
}

export type SessionReplayWindow = {
  windowId: string;
  chunkCount: number;
  fullSnapshotCount: number;
  startedAtMs: number;
  endedAtMs: number;
  // Raw wall-clock span (max ended_at − min started_at). This is the coordinate
  // the player/scrubber uses — rrweb positions events at their true timestamps.
  durationMs: number;
  // Honest "how long was this actually recorded" duration: the sum of each
  // chunk's own span, which excludes the dead gaps *between* chunks. window_id
  // persists in sessionStorage across reloads/SPA-navs, so one window can glue
  // dozens of page-loads together with huge idle gaps — `durationMs` counts that
  // dead air (a tab reads 163 min when only ~16 min was recorded), this doesn't.
  activeDurationMs: number;
};

/**
 * Lists the distinct recorders (windows) that wrote to a session. Each row is
 * one tab / page-load, identified by window_id. The session detail page uses
 * this to render a "Recording 1 / Recording 2 / ..." selector so the player
 * can play one window at a time instead of mixing chunks from concurrent tabs.
 *
 * Legacy chunks (recorded before window_id existed) have window_id = '' and
 * collapse into a single "legacy" entry.
 */
export async function getSessionWindows(
  sessionId: string,
  projectId: string,
  opts: { signal?: AbortSignal | null } = {},
): Promise<SessionReplayWindow[]> {
  const resolved = await resolveReplay(sessionId, projectId, opts.signal);
  if (isBlocksResolved(resolved)) {
    // index is never empty for a 'blocks' session (see resolveBlocksReplay)
    return computeReplayWindows(resolved.index, REPLAY_IDLE_GAP_MS).map(
      (w) => ({
        windowId: w.windowId,
        chunkCount: w.chunkCount,
        fullSnapshotCount: w.fullSnapshotCount,
        startedAtMs: w.startedAtMs,
        endedAtMs: w.endedAtMs,
        durationMs: Math.max(0, w.endedAtMs - w.startedAtMs),
        activeDurationMs: Math.max(0, w.activeMs),
      }),
    );
  }
  const src = resolved.legacy;
  const rows = await chQuery<{
    window_id: string;
    chunk_count: string;
    full_snapshot_count: string;
    started_at_ms: string;
    ended_at_ms: string;
    active_ms: string;
  }>(
    // active_ms = raw span minus the idle gaps (≥ REPLAY_IDLE_GAP_MS) between
    // consecutive chunks. This is the SAME definition as getSessionWindowSegments
    // (merge chunks whose gap < threshold, collapse the larger gaps), so the tab
    // chip and the player's gap-collapsed scrubber/readout always agree.
    `SELECT
       window_id,
       toString(uniqExact(chunk_index, s_ms)) AS chunk_count,
       toString(countIf(is_full_snapshot)) AS full_snapshot_count,
       min(s_ms) AS started_at_ms,
       max(e_ms) AS ended_at_ms,
       toString(${replayActiveMsExpr}) AS active_ms
     FROM (
       ${replayWindowRowsSql(src.from, replayScope(sessionId, projectId), 'window_id', 'is_full_snapshot, chunk_index')}
     )
     GROUP BY window_id
     ORDER BY started_at_ms`,
    src.settings,
  );

  return rows.map((row) => {
    const startedAtMs = Number(row.started_at_ms);
    const endedAtMs = Number(row.ended_at_ms);
    return {
      windowId: row.window_id,
      chunkCount: Number(row.chunk_count),
      fullSnapshotCount: Number(row.full_snapshot_count),
      startedAtMs,
      endedAtMs,
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      activeDurationMs: Math.max(0, Number(row.active_ms)),
    };
  });
}

export type SessionReplaySegment = { startMs: number; endMs: number };

/**
 * Active recording segments for a window, as wall-clock [startMs, endMs] ranges
 * with the large idle gaps between chunks removed. The player stays wall-clock;
 * the scrubber uses these to render a gap-collapsed timeline (PostHog-style) so
 * a tab that spans 3 hours of mostly-idle air shows its ~few minutes of real
 * activity with proper spacing.
 *
 * Contiguous chunks (gap < REPLAY_IDLE_GAP_MS) merge into one segment; a larger
 * gap starts a new segment (the gap itself is the collapsed idle period).
 */
export async function getSessionWindowSegments(
  sessionId: string,
  projectId: string,
  windowId?: string,
  opts: { signal?: AbortSignal | null } = {},
): Promise<SessionReplaySegment[]> {
  let resolved = await resolveReplay(sessionId, projectId, opts.signal);
  if (isBlocksResolved(resolved)) {
    const segments = computeReplaySegments(
      resolved.index,
      REPLAY_IDLE_GAP_MS,
      windowId,
    );
    if (segments.length > 0) return segments;
    // window not in blocks → legacy
    resolved = await resolveLegacyReplay(sessionId, projectId);
  }
  const src = resolved.legacy;
  const windowScope =
    windowId !== undefined
      ? `AND window_id = ${sqlstring.escape(windowId)}`
      : '';
  const rows = await chQuery<{ start_ms: string; end_ms: string }>(
    `SELECT
       toUnixTimestamp64Milli(started_at) AS start_ms,
       toUnixTimestamp64Milli(ended_at) AS end_ms
     FROM ${src.from}
     WHERE session_id = ${sqlstring.escape(sessionId)}
       AND project_id = ${sqlstring.escape(projectId)}
       ${windowScope}
     ORDER BY started_at`,
    src.settings,
  );

  const segments: SessionReplaySegment[] = [];
  for (const row of rows) {
    const startMs = Number(row.start_ms);
    const endMs = Math.max(startMs, Number(row.end_ms));
    const last = segments[segments.length - 1];
    // Merge into the current segment when this chunk starts within the idle
    // threshold of the last one's end (normal recording flow); otherwise the
    // gap is idle → start a fresh segment.
    if (last && startMs - last.endMs < REPLAY_IDLE_GAP_MS) {
      if (endMs > last.endMs) last.endMs = endMs;
    } else {
      segments.push({ startMs, endMs });
    }
  }
  return segments;
}

/**
 * Returns the definitive replay duration + chunk count for a session.
 * Used by the player to display the FINAL duration upfront — instead of the
 * progressive `getMetaData().totalTime` that grows as chunks arrive (which
 * makes the timeline jump from "2 min" to "35 min" to "80 min" as the user
 * watches).
 */
export async function getSessionReplayMeta(
  sessionId: string,
  projectId: string,
  opts: { signal?: AbortSignal | null } = {},
): Promise<{
  startedAtMs: number;
  endedAtMs: number;
  totalDurationMs: number;
  totalChunkCount: number;
  /** 'ch' hot table · 'blob' cold archive · 'blocks' Azure Blob blocks */
  source: ResolvedReplay['kind'];
}> {
  const resolved = await resolveReplay(sessionId, projectId, opts.signal);
  if (isBlocksResolved(resolved)) {
    const meta = computeReplayMeta(resolved.index);
    return {
      startedAtMs: meta?.startedAtMs ?? 0,
      endedAtMs: meta?.endedAtMs ?? 0,
      totalDurationMs: meta
        ? Math.max(0, meta.endedAtMs - meta.startedAtMs)
        : 0,
      totalChunkCount: meta?.chunkCount ?? 0,
      source: resolved.kind,
    };
  }
  const src = resolved.legacy;
  const rows = await chQuery<{
    started_at_ms: string;
    ended_at_ms: string;
    chunk_count: string;
  }>(
    `SELECT
       toUnixTimestamp64Milli(min(started_at)) AS started_at_ms,
       toUnixTimestamp64Milli(max(ended_at)) AS ended_at_ms,
       toString(uniqExact(window_id, chunk_index, started_at)) AS chunk_count
     FROM ${src.from}
     WHERE session_id = ${sqlstring.escape(sessionId)}
       AND project_id = ${sqlstring.escape(projectId)}`,
    src.settings,
  );
  const row = rows[0];
  if (!row) {
    return {
      startedAtMs: 0,
      endedAtMs: 0,
      totalDurationMs: 0,
      totalChunkCount: 0,
      source: src.kind,
    };
  }
  const startedAtMs = Number(row.started_at_ms);
  const endedAtMs = Number(row.ended_at_ms);
  const totalChunkCount = Number(row.chunk_count);
  return {
    startedAtMs,
    endedAtMs,
    totalDurationMs: Math.max(0, endedAtMs - startedAtMs),
    totalChunkCount,
    // 'blob' = served from Azure archive, 'ch' = ClickHouse hot table.
    source: src.kind,
  };
}

/**
 * Smart seek fetch — given a target wall-clock ms inside a session, returns:
 * - The latest `is_full_snapshot = true` chunk at or before the target (the
 *   "anchor" — rrweb needs this to reconstruct the DOM at the target frame),
 * - Plus every chunk between that anchor and target + lookaheadMs (so the user
 *   can play forward without an immediate re-buffer).
 *
 * This is the long-session fast-path: instead of sequentially walking
 * thousands of chunks from chunk_index 0 to the target, we ask CH directly
 * "where's the last snapshot before T?" and load only the slice we need.
 * One round trip, typically <100 chunks, even when seeking to hour 8 of an
 * 86k-event session.
 */
export async function getSessionReplayChunksAroundTime(
  sessionId: string,
  projectId: string,
  targetMs: number,
  lookaheadMs = 30_000,
  windowId?: string,
  opts: { signal?: AbortSignal | null } = {},
) {
  let resolved = await resolveReplay(sessionId, projectId, opts.signal);
  // Anchor = seq of the most recent full snapshot at or before the target
  // (rrweb needs it to rebuild the DOM). None → seq 0.
  const target = Math.floor(targetMs);
  const until = Math.floor(targetMs + lookaheadMs);
  if (isBlocksResolved(resolved)) {
    const all = blocksScopeKeys(resolved, windowId);
    if (all) {
      const anchor = replayAnchorSeq(all, target);
      const page = all.filter((k) => k.seq >= anchor && k.startedMs <= until);
      const data = await loadBlocksPage(
        sessionId,
        projectId,
        windowId,
        page,
        opts.signal,
      );
      if (data) return { data, anchorChunkIndex: anchor };
    }
    resolved = await resolveLegacyReplay(sessionId, projectId);
  }
  const src = resolved.legacy;
  const scope = replayScope(sessionId, projectId, windowId);
  let anchorIndex: number;
  let keys: ReplayChunkKey[];
  if (src.kind === 'blob') {
    const all = await blobChunkKeys(src, scope);
    anchorIndex = all.reduce(
      (a, k) =>
        k.is_full_snapshot && Number(k.started_ms) <= target
          ? Math.max(a, k.seq)
          : a,
      0,
    );
    keys = all.filter(
      (k) => k.seq >= anchorIndex && Number(k.started_ms) <= until,
    );
  } else {
    const rows = await chQuery<ReplayChunkKey & { anchor_seq: string }>(
      `WITH k AS (${replayChunkKeysSql(src, scope)})
       SELECT seq, chunk_index, started_ms,
              (SELECT max(seq) FROM k
                WHERE is_full_snapshot AND started_ms <= ${target}) AS anchor_seq
       FROM k
       WHERE seq >= anchor_seq
         AND started_ms <= ${until}
       ORDER BY seq`,
      src.settings,
    );
    anchorIndex = Math.max(0, Number(rows[0]?.anchor_seq ?? 0) || 0);
    keys = rows;
  }
  const items = await loadReplayChunksForKeys(src, scope, keys);
  return { data: items, anchorChunkIndex: anchorIndex };
}

export async function getSessionReplayChunksByIndexRange(
  sessionId: string,
  projectId: string,
  fromIndex: number,
  toIndex: number,
  windowId?: string,
  opts: { signal?: AbortSignal | null } = {},
) {
  if (toIndex < fromIndex) {
    return { data: [] as ReplayChunkItem[] };
  }
  let resolved = await resolveReplay(sessionId, projectId, opts.signal);
  const lo = Math.floor(fromIndex);
  const hi = Math.floor(toIndex);
  if (isBlocksResolved(resolved)) {
    const all = blocksScopeKeys(resolved, windowId);
    if (all) {
      const page = all.filter((k) => k.seq >= lo && k.seq <= hi);
      const data = await loadBlocksPage(
        sessionId,
        projectId,
        windowId,
        page,
        opts.signal,
      );
      if (data) return { data };
    }
    resolved = await resolveLegacyReplay(sessionId, projectId);
  }
  const src = resolved.legacy;
  const scope = replayScope(sessionId, projectId, windowId);
  const keys =
    src.kind === 'blob'
      ? (await blobChunkKeys(src, scope)).filter(
          (k) => k.seq >= lo && k.seq <= hi,
        )
      : await chQuery<ReplayChunkKey>(
          `SELECT seq, chunk_index, started_ms
           FROM (${replayChunkKeysSql(src, scope)})
           WHERE seq BETWEEN ${lo} AND ${hi}
           ORDER BY seq`,
          src.settings,
        );
  return { data: await loadReplayChunksForKeys(src, scope, keys) };
}

export async function batchSessionHasReplay(
  sessionIds: string[],
  projectId: string,
): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  try {
    const proj = sqlstring.escape(projectId);
    const inList = sessionIds.map((id) => sqlstring.escape(id)).join(',');
    // Blob ON → also consult the TTL-free archive index so sessions whose
    // chunks have been trimmed from ClickHouse still report hasReplay=true.
    let sql = REPLAY_BLOB_CONN
      ? `SELECT DISTINCT session_id
       FROM ${TABLE_NAMES.session_replay_chunks}
       WHERE project_id = ${proj}
         AND session_id IN (${inList})
       UNION DISTINCT
       SELECT DISTINCT session_id
       FROM ${REPLAY_ARCHIVE_INDEX} FINAL
       WHERE project_id = ${proj}
         AND session_id IN (${inList})`
      : `SELECT DISTINCT session_id
       FROM ${TABLE_NAMES.session_replay_chunks}
       WHERE project_id = ${proj}
         AND session_id IN (${inList})`;
    // Blocks-served project → a Blob-only session (refs, no CH chunks) counts.
    if (isReplayBlocksServingEnabled(projectId)) {
      sql = `${sql}
       UNION DISTINCT
       ${replayBlockSessionIdsSql(projectId, `session_id IN (${inList})`)}`;
    }
    const rows = await chQuery<{ session_id: string }>(sql);
    return new Set(rows.map((r) => r.session_id));
  } catch {
    return new Set();
  }
}

export type SessionReplayDuration = { durationMs: number; tabCount: number };

/**
 * Recording length per session for the replays list = the SAME idle-collapsed
 * active time the player's readout and tab chips show (replayActiveMsExpr),
 * summed over the session's tabs. (Previously: the sum of each chunk's own
 * span — which dropped the few seconds between chunks, double-counted
 * duplicate rows, and so never matched the player.)
 *
 * Reads the CH hot table in one batched query (the list's 14-day window is
 * well inside the 90-day TTL). Any session CH no longer has — e.g. chunks
 * deleted after Blob archiving — is computed from the archive per session,
 * never replaced by the unrelated event-span duration.
 */
export async function batchSessionReplayDuration(
  sessionIds: string[],
  projectId: string,
): Promise<Map<string, SessionReplayDuration>> {
  const result = new Map<string, SessionReplayDuration>();
  if (sessionIds.length === 0) return result;
  let chOk = false;
  try {
    const inList = sessionIds.map((id) => sqlstring.escape(id)).join(',');
    const durRows = await replayDurationRowsSource(
      projectId,
      `project_id = ${sqlstring.escape(projectId)} AND session_id IN (${inList})`,
    );
    const rows = await chQuery<{
      session_id: string;
      duration_ms: string;
      tab_count: string;
    }>(
      `SELECT session_id,
              toString(sum(active_ms)) AS duration_ms,
              toString(count()) AS tab_count
       FROM (
         SELECT session_id, window_id, ${replayActiveMsExpr} AS active_ms
         FROM (
           ${replayWindowRowsSql(
             durRows.from,
             durRows.where,
             'session_id, window_id',
           )}
         )
         GROUP BY session_id, window_id
       )
       GROUP BY session_id`,
    );
    for (const r of rows) {
      result.set(r.session_id, {
        durationMs: Math.max(0, Number(r.duration_ms)),
        tabCount: Number(r.tab_count),
      });
    }
    chOk = true;
  } catch (error) {
    replayLogger.warn('batchSessionReplayDuration failed', { error });
  }

  // Archived-only sessions (not in CH): resolve via the Blob-aware windows query.
  // Skipped if the CH query itself failed, so an outage can't fan out into
  // one Blob read per row.
  const missing =
    REPLAY_BLOB_CONN && chOk ? sessionIds.filter((id) => !result.has(id)) : [];
  await Promise.all(
    missing.map(async (id) => {
      try {
        const windows = await getSessionWindows(id, projectId);
        if (windows.length === 0) return;
        result.set(id, {
          durationMs: windows.reduce((a, w) => a + w.activeDurationMs, 0),
          tabCount: windows.length,
        });
      } catch {
        // leave unset — the list falls back to the session's own duration
      }
    }),
  );
  return result;
}

export async function sessionHasReplay(
  sessionId: string,
  projectId: string,
): Promise<boolean> {
  const sid = sqlstring.escape(sessionId);
  const proj = sqlstring.escape(projectId);
  // Blob ON → "has replay" = present in the CH hot chunks OR the TTL-free
  // archive index (so a trimmed-from-CH session still counts as having one).
  let sql = REPLAY_BLOB_CONN
    ? `SELECT 1 AS has
     FROM ${TABLE_NAMES.session_replay_chunks}
     WHERE session_id = ${sid}
       AND project_id = ${proj}
     LIMIT 1
     UNION ALL
     SELECT 1 AS has
     FROM ${REPLAY_ARCHIVE_INDEX} FINAL
     WHERE session_id = ${sid}
       AND project_id = ${proj}
     LIMIT 1`
    : `SELECT 1 AS has
     FROM ${TABLE_NAMES.session_replay_chunks}
     WHERE session_id = ${sid}
       AND project_id = ${proj}
     LIMIT 1`;
  // Blocks-served project → a Blob-only session (refs, no CH chunks) counts.
  if (isReplayBlocksServingEnabled(projectId)) {
    sql = `${sql}
     UNION ALL
     SELECT 1 AS has
     FROM ${TABLE_NAMES.session_replay_blocks}
     WHERE session_id = ${sid}
       AND project_id = ${proj}
     LIMIT 1`;
  }
  const rows = await chQuery<{ has: number }>(sql);
  return rows.length > 0;
}
