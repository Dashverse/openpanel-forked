import { cacheable } from '@openpanel/redis';
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
  const chunkScope = `project_id = ${proj}
        AND started_at > now() - INTERVAL ${days} DAY
        AND started_at <= now()`;
  const conds = [
    `project_id = ${proj}`,
    `created_at > now() - INTERVAL ${days} DAY`,
    // Prune the event scan to the days that actually have replays (same
    // data-derived trick as buildHasReplayWhere). Without this a high-frequency
    // event (e.g. showOpen) is scanned across the whole org window (360d, 100M+
    // rows). Replays are sparse/recent, so this cuts it to a handful of days.
    `toDate(created_at) IN (
        SELECT arrayJoin([d - 1, d])
        FROM (
          SELECT DISTINCT toDate(started_at) AS d
          FROM ${TABLE_NAMES.session_replay_chunks}
          WHERE ${chunkScope}
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
  const proj = sqlstring.escape(projectId);
  const scope = `project_id = ${proj}
        AND started_at > now() - INTERVAL ${days} DAY
        AND started_at <= now()`;
  return `id IN (
      SELECT DISTINCT session_id
      FROM ${TABLE_NAMES.session_replay_chunks}
      WHERE ${scope}
    )
    AND created_at > now() - INTERVAL ${days} DAY
    AND toDate(created_at) IN (
      SELECT arrayJoin([d - 1, d])
      FROM (
        SELECT DISTINCT toDate(started_at) AS d
        FROM ${TABLE_NAMES.session_replay_chunks}
        WHERE ${scope}
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
}: GetSessionListOptions) {
  const { sb, getSql } = createSqlBuilder();

  sb.from = `${TABLE_NAMES.sessions} FINAL`;
  sb.limit = take;
  sb.where.projectId = `project_id = ${sqlstring.escape(projectId)}`;

  if (startDate && endDate) {
    sb.where.range = `created_at BETWEEN toDateTime('${formatClickhouseDate(startDate)}') AND toDateTime('${formatClickhouseDate(endDate)}')`;
  }

  if (profileId)
    sb.where.profileId = `profile_id = ${sqlstring.escape(profileId)}`;
  if (search) {
    sb.where.search = buildSessionSearchWhere(search);
  }
  if (filters?.length) {
    Object.assign(sb.where, getEventFiltersWhereClause(filters));
  }

  // This will speed up the query quite a lot for big organizations
  const dateIntervalInDays = onlyReplays
    ? await getReplayLookbackDays(projectId)
    : await getSessionLookbackDays(projectId);

  if (onlyReplays) {
    // Keep only sessions with a replay recording, within the same date window.
    sb.where.hasReplay = buildHasReplayWhere(projectId, dateIntervalInDays);
    // Hide trivial/empty recordings (PostHog defaults to > 5s).
    sb.where.minDuration = `duration >= ${MIN_REPLAY_DURATION_MS}`;
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

  if (cursor) {
    const cAt = sqlstring.escape(cursor.createdAt);
    // TODO: remove id from cursor
    const cId = sqlstring.escape(cursor.id);
    sb.where.cursor = `created_at < toDateTime64(${cAt}, 3)`;
    sb.where.cursorWindow = `created_at >= toDateTime64(${cAt}, 3) - INTERVAL ${dateIntervalInDays} DAY`;
    sb.orderBy.created_at = 'created_at DESC';
  } else {
    sb.orderBy.created_at = 'created_at DESC';
    sb.where.created_at = `created_at > now() - INTERVAL ${dateIntervalInDays} DAY`;
  }

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

  const sql = getSql();
  const data = await chQuery<
    IClickhouseSession & {
      latestCreatedAt: string;
    }
  >(sql);

  // Compute cursors from page edges
  const last = data[take - 1];

  const meta: PageInfo = {
    next: last
      ? {
          createdAt: last.created_at,
          id: last.id,
        }
      : undefined,
  };

  // Profile hydration (unchanged)
  const profileIds = Array.from(new Set(data.map((e) => e.profile_id)));
  const profiles = await getProfilesCached(profileIds, projectId);
  const map = new Map<string, IServiceProfile>(profiles.map((p) => [p.id, p]));

  const sessionIds = data.map((s) => s.id);
  const [replaySet, replayDurations] = await Promise.all([
    batchSessionHasReplay(sessionIds, projectId),
    onlyReplays
      ? batchSessionReplayDuration(sessionIds, projectId)
      : Promise.resolve(undefined),
  ]);

  const items = data.map(transformSession).map((item) => ({
    ...item,
    hasReplay: replaySet.has(item.id),
    // On the replays list, show the RECORDING length (what the player plays),
    // not the tracked-event span — the recorder starts before the first event
    // and runs past the last, so the two legitimately differ.
    duration: replayDurations?.get(item.id) ?? item.duration,
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
}: Omit<GetSessionListOptions, 'take' | 'cursor'>) {
  const { sb, getSql } = createSqlBuilder();

  // uniqExact(id) — count DISTINCT sessions. `count(*) WHERE sign=1` over-counts
  // a VersionedCollapsingMergeTree by the number of un-merged session versions.
  sb.select.count = 'uniqExact(id) as count';
  sb.where.projectId = `project_id = ${sqlstring.escape(projectId)}`;
  sb.where.sign = 'sign = 1';

  if (onlyReplays) {
    const days = onlyReplays
      ? await getReplayLookbackDays(projectId)
      : await getSessionLookbackDays(projectId);
    sb.where.hasReplay = buildHasReplayWhere(projectId, days);
    // Hide trivial/empty recordings (PostHog defaults to > 5s). Half of dashreels
    // replay sessions are < 5s (0:00 rows) and just pad the count.
    sb.where.minDuration = `duration >= ${MIN_REPLAY_DURATION_MS}`;
  }

  if (profileId) {
    sb.where.profileId = `profile_id = ${sqlstring.escape(profileId)}`;
  }

  if (startDate && endDate) {
    sb.where.created_at = `toDate(created_at) BETWEEN toDate('${formatClickhouseDate(startDate)}') AND toDate('${formatClickhouseDate(endDate)}')`;
  }

  if (search) {
    sb.where.search = buildSessionSearchWhere(search);
  }

  if (replayEventNames?.length || replayEventFilters?.length) {
    const days = onlyReplays
      ? await getReplayLookbackDays(projectId)
      : await getSessionLookbackDays(projectId);
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

export async function getSessionReplayChunksFrom(
  sessionId: string,
  projectId: string,
  fromIndex: number,
  windowId?: string,
) {
  // When a windowId is supplied, scope chunks to that single recorder
  // (one tab / one page-load). This is what keeps multi-tab sessions
  // playable: each window's chunk_index sequence is clean 0..N, so feeding
  // one window at a time never mixes rrweb mirror states across recorders.
  //
  // Without a windowId (legacy / single-window sessions) we fall back to
  // the old behaviour: LIMIT 1 BY chunk_index dedupes duplicate rows at the
  // same chunk_index by keeping the earliest one.
  const windowFilter =
    windowId !== undefined
      ? `AND window_id = ${sqlstring.escape(windowId)}`
      : '';
  const rows = await chQuery<ReplayChunkRow>(
    `SELECT chunk_index,
            payload,
            started_at AS chunk_started_at,
            ended_at AS chunk_ended_at
     FROM ${TABLE_NAMES.session_replay_chunks}
     WHERE session_id = ${sqlstring.escape(sessionId)}
       AND project_id = ${sqlstring.escape(projectId)}
       ${windowFilter}
     ORDER BY chunk_index, started_at
     LIMIT 1 BY chunk_index
     LIMIT ${REPLAY_CHUNKS_PAGE_SIZE + 1}
     OFFSET ${fromIndex}`,
  );

  const items = rows
    .slice(0, REPLAY_CHUNKS_PAGE_SIZE)
    .map((row, index) => transformReplayChunkRow(row, index + fromIndex));

  return {
    data: items,
    hasMore: rows.length > REPLAY_CHUNKS_PAGE_SIZE,
  };
}

// A recording's window_id is reused across reloads/idle, so its raw span is
// mostly dead air between chunks. Chunk gaps larger than this are treated as
// idle and collapsed on the scrubber (matches "skip idle" playback semantics).
// Shared by getSessionWindows (chip duration) and getSessionWindowSegments
// (scrubber) so the two always agree.
const REPLAY_IDLE_GAP_MS = 15_000;

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
): Promise<SessionReplayWindow[]> {
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
       toString(count(DISTINCT chunk_index)) AS chunk_count,
       toString(countIf(is_full_snapshot)) AS full_snapshot_count,
       toUnixTimestamp64Milli(min(started_at)) AS started_at_ms,
       toUnixTimestamp64Milli(max(ended_at)) AS ended_at_ms,
       toString(greatest(0,
         (toUnixTimestamp64Milli(max(ended_at)) - toUnixTimestamp64Milli(min(started_at)))
         - sum(if(prev_e_ms > 0 AND (s_ms - prev_e_ms) >= ${REPLAY_IDLE_GAP_MS}, s_ms - prev_e_ms, 0))
       )) AS active_ms
     FROM (
       SELECT
         window_id, chunk_index, is_full_snapshot, started_at, ended_at,
         toUnixTimestamp64Milli(started_at) AS s_ms,
         lagInFrame(toUnixTimestamp64Milli(ended_at)) OVER (
           PARTITION BY window_id ORDER BY started_at
           ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
         ) AS prev_e_ms
       FROM ${TABLE_NAMES.session_replay_chunks}
       WHERE session_id = ${sqlstring.escape(sessionId)}
         AND project_id = ${sqlstring.escape(projectId)}
     )
     GROUP BY window_id
     ORDER BY started_at_ms`,
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
): Promise<SessionReplaySegment[]> {
  const windowScope =
    windowId !== undefined
      ? `AND window_id = ${sqlstring.escape(windowId)}`
      : '';
  const rows = await chQuery<{ start_ms: string; end_ms: string }>(
    `SELECT
       toUnixTimestamp64Milli(started_at) AS start_ms,
       toUnixTimestamp64Milli(ended_at) AS end_ms
     FROM ${TABLE_NAMES.session_replay_chunks}
     WHERE session_id = ${sqlstring.escape(sessionId)}
       AND project_id = ${sqlstring.escape(projectId)}
       ${windowScope}
     ORDER BY started_at`,
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
) {
  const rows = await chQuery<{
    started_at_ms: string;
    ended_at_ms: string;
    chunk_count: string;
  }>(
    `SELECT
       toUnixTimestamp64Milli(min(started_at)) AS started_at_ms,
       toUnixTimestamp64Milli(max(ended_at)) AS ended_at_ms,
       toString(count(DISTINCT chunk_index)) AS chunk_count
     FROM ${TABLE_NAMES.session_replay_chunks}
     WHERE session_id = ${sqlstring.escape(sessionId)}
       AND project_id = ${sqlstring.escape(projectId)}`,
  );
  const row = rows[0];
  if (!row) {
    return { startedAtMs: 0, endedAtMs: 0, totalDurationMs: 0, totalChunkCount: 0 };
  }
  const startedAtMs = Number(row.started_at_ms);
  const endedAtMs = Number(row.ended_at_ms);
  const totalChunkCount = Number(row.chunk_count);
  return {
    startedAtMs,
    endedAtMs,
    totalDurationMs: Math.max(0, endedAtMs - startedAtMs),
    totalChunkCount,
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
) {
  const windowFilter =
    windowId !== undefined
      ? `AND window_id = ${sqlstring.escape(windowId)}`
      : '';
  // Find the anchor chunk_index — the most recent full snapshot at or before
  // the target. If none exists (shouldn't happen — every session starts with
  // a full snapshot at chunk 0), fall back to chunk 0.
  const anchorRows = await chQuery<{ anchor_index: string }>(
    `SELECT toString(max(chunk_index)) AS anchor_index
     FROM ${TABLE_NAMES.session_replay_chunks}
     WHERE session_id = ${sqlstring.escape(sessionId)}
       AND project_id = ${sqlstring.escape(projectId)}
       ${windowFilter}
       AND is_full_snapshot = true
       AND toUnixTimestamp64Milli(started_at) <= ${Math.floor(targetMs)}`,
  );
  const anchorIndex = Math.max(
    0,
    Number.parseInt(anchorRows[0]?.anchor_index ?? '0', 10) || 0,
  );

  const rows = await chQuery<ReplayChunkRow>(
    `SELECT chunk_index,
            payload,
            started_at AS chunk_started_at,
            ended_at AS chunk_ended_at
     FROM ${TABLE_NAMES.session_replay_chunks}
     WHERE session_id = ${sqlstring.escape(sessionId)}
       AND project_id = ${sqlstring.escape(projectId)}
       ${windowFilter}
       AND chunk_index >= ${anchorIndex}
       AND toUnixTimestamp64Milli(started_at) <= ${Math.floor(targetMs + lookaheadMs)}
     ORDER BY chunk_index, started_at
     LIMIT 1 BY chunk_index`,
  );

  const items = rows.map((row) =>
    transformReplayChunkRow(row, row.chunk_index),
  );

  return { data: items, anchorChunkIndex: anchorIndex };
}

export async function getSessionReplayChunksByIndexRange(
  sessionId: string,
  projectId: string,
  fromIndex: number,
  toIndex: number,
  windowId?: string,
) {
  if (toIndex < fromIndex) {
    return { data: [] as ReplayChunkItem[] };
  }
  const windowFilter =
    windowId !== undefined
      ? `AND window_id = ${sqlstring.escape(windowId)}`
      : '';
  const rows = await chQuery<ReplayChunkRow>(
    `SELECT chunk_index,
            payload,
            started_at AS chunk_started_at,
            ended_at AS chunk_ended_at
     FROM ${TABLE_NAMES.session_replay_chunks}
     WHERE session_id = ${sqlstring.escape(sessionId)}
       AND project_id = ${sqlstring.escape(projectId)}
       ${windowFilter}
       AND chunk_index BETWEEN ${Math.floor(fromIndex)} AND ${Math.floor(toIndex)}
     ORDER BY chunk_index, started_at
     LIMIT 1 BY chunk_index`,
  );

  const items = rows.map((row) =>
    transformReplayChunkRow(row, row.chunk_index),
  );

  return { data: items };
}

export async function batchSessionHasReplay(
  sessionIds: string[],
  projectId: string,
): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  try {
    const inList = sessionIds.map((id) => sqlstring.escape(id)).join(',');
    const rows = await chQuery<{ session_id: string }>(
      `SELECT DISTINCT session_id
       FROM ${TABLE_NAMES.session_replay_chunks}
       WHERE project_id = ${sqlstring.escape(projectId)}
         AND session_id IN (${inList})`,
    );
    return new Set(rows.map((r) => r.session_id));
  } catch {
    return new Set();
  }
}

/**
 * Recording length (ms) per session = max(ended_at) − min(started_at) over its
 * replay chunks. This is the duration the player shows, which differs from the
 * sessions table `duration` (span of tracked events): the recorder starts
 * before the first event and keeps capturing DOM activity after the last one.
 * Scoped to a small IN-list of session_ids, so it stays cheap on the big table.
 */
export async function batchSessionReplayDuration(
  sessionIds: string[],
  projectId: string,
): Promise<Map<string, number>> {
  if (sessionIds.length === 0) return new Map();
  try {
    const inList = sessionIds.map((id) => sqlstring.escape(id)).join(',');
    const rows = await chQuery<{ session_id: string; duration_ms: string }>(
      // Active recording time = the sum of each chunk's OWN span, not
      // max(ended_at) - min(started_at). The wall-clock envelope over-counts
      // badly: it includes idle gaps between chunks (the recorder pauses while
      // the DOM is static) and spans every tab, so a mostly-idle 30-min session
      // with ~25s of real activity showed "29:03". Summing per-chunk spans
      // yields the length the player actually plays (idle excluded).
      `SELECT session_id,
              sum(toUnixTimestamp64Milli(ended_at) - toUnixTimestamp64Milli(started_at)) AS duration_ms
       FROM ${TABLE_NAMES.session_replay_chunks}
       WHERE project_id = ${sqlstring.escape(projectId)}
         AND session_id IN (${inList})
       GROUP BY session_id`,
    );
    return new Map(
      rows.map((r) => [r.session_id, Math.max(0, Number(r.duration_ms))]),
    );
  } catch {
    return new Map();
  }
}

export async function sessionHasReplay(
  sessionId: string,
  projectId: string,
): Promise<boolean> {
  const rows = await chQuery<{ has: number }>(
    `SELECT 1 AS has
     FROM ${TABLE_NAMES.session_replay_chunks}
     WHERE session_id = ${sqlstring.escape(sessionId)}
       AND project_id = ${sqlstring.escape(projectId)}
     LIMIT 1`,
  );
  return rows.length > 0;
}
