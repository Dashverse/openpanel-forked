import sqlstring from 'sqlstring';
import type { IChartEventFilter, IChartInput } from '@openpanel/validation';
import { TABLE_NAMES, chMcp } from '../clickhouse/client';
import { executeChart } from '../engine';
import { assertEventNamesExist } from './chart.service';
import { getEventList } from './event.service';
import { getProfileById } from './profile.service';
import { getSessionList } from './session.service';

/**
 * Headless cores for the MCP layer that are simple, self-contained ClickHouse
 * reads (no chart engine). All run on `chMcp` (5s-capped, read-only-user hook)
 * and hit correctly-keyed catalogs so they're fast:
 *   - event names   → distinct_event_names_mv, ORDER BY (project_id, name)
 *   - properties    → event_property_values_mv, name-scoped prefix
 *   - values        → event_property_values_mv, (name, property_key) prefix
 *   - identity      → profile_aliases (anon/device ↔ canonical person)
 */
const esc = (v: string) => sqlstring.escape(v);

/** List an event catalog for a project (optionally filtered by substring). */
export async function getEventNamesCore(input: {
  projectId: string;
  search?: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
  const search = input.search
    ? `AND positionCaseInsensitive(name, ${esc(input.search)}) > 0`
    : '';
  const res = await chMcp.query({
    query: `SELECT name, sum(event_count) AS events, max(last_seen) AS last_seen
      FROM ${TABLE_NAMES.event_names_mv}
      WHERE project_id = ${esc(input.projectId)} ${search}
      GROUP BY name ORDER BY events DESC LIMIT ${limit}`,
    format: 'JSONEachRow',
  });
  const rows = await res.json<{
    name: string;
    events: string;
    last_seen: string;
  }>();
  return {
    events: rows.map((r) => ({
      name: r.name,
      totalEvents: Number(r.events),
      lastSeen: r.last_seen,
    })),
  };
}

/** List the property keys seen on a specific event (name-scoped = fast). */
export async function getEventPropertiesCore(input: {
  projectId: string;
  eventName: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
  const res = await chMcp.query({
    query: `SELECT property_key, uniqExact(property_value) AS distinct_values
      FROM ${TABLE_NAMES.event_property_values_mv}
      WHERE project_id = ${esc(input.projectId)} AND name = ${esc(input.eventName)}
      GROUP BY property_key ORDER BY distinct_values DESC LIMIT ${limit}`,
    format: 'JSONEachRow',
  });
  const rows = await res.json<{
    property_key: string;
    distinct_values: string;
  }>();
  return {
    eventName: input.eventName,
    properties: rows.map((r) => ({
      // present as the filter/breakdown name the tools expect
      property: `properties.${r.property_key}`,
      key: r.property_key,
      distinctValues: Number(r.distinct_values),
    })),
  };
}

/** List the distinct values of one property on one event (fast prefix). */
export async function getPropertyValuesCore(input: {
  projectId: string;
  eventName: string;
  property: string; // "gateway" or "properties.gateway"
  limit?: number;
}) {
  const key = input.property.replace(/^properties\./, '');
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const res = await chMcp.query({
    query: `SELECT DISTINCT property_value AS value
      FROM ${TABLE_NAMES.event_property_values_mv}
      WHERE project_id = ${esc(input.projectId)} AND name = ${esc(input.eventName)}
        AND property_key = ${esc(key)}
      ORDER BY value LIMIT ${limit}`,
    format: 'JSONEachRow',
  });
  const rows = await res.json<{ value: string }>();
  return {
    eventName: input.eventName,
    property: `properties.${key}`,
    values: rows.map((r) => r.value),
  };
}

/**
 * Resolve an id to its canonical person and list its anon/device aliases.
 * Fork differentiator — surfaces the pre/post-login identity graph
 * (profile_aliases: alias = anon/$device_id, profile_id = canonical/$user_id).
 */
export async function resolveIdentityCore(input: {
  projectId: string;
  id: string;
}) {
  const pid = esc(input.projectId);
  const id = esc(input.id);

  // If the id is an alias, its canonical profile_id; else the id is canonical.
  const canonRes = await chMcp.query({
    query: `SELECT profile_id FROM ${TABLE_NAMES.alias}
      WHERE project_id = ${pid} AND alias = ${id}
      ORDER BY created_at DESC LIMIT 1`,
    format: 'JSONEachRow',
  });
  const canonRows = await canonRes.json<{ profile_id: string }>();
  const canonical = canonRows[0]?.profile_id ?? input.id;

  const aliasRes = await chMcp.query({
    query: `SELECT DISTINCT alias FROM ${TABLE_NAMES.alias}
      WHERE project_id = ${pid} AND profile_id = ${esc(canonical)} LIMIT 100`,
    format: 'JSONEachRow',
  });
  const aliases = (await aliasRes.json<{ alias: string }>()).map(
    (r) => r.alias,
  );

  return {
    input: input.id,
    canonicalProfileId: canonical,
    isAnonymousAlias: canonical !== input.id,
    aliases,
  };
}

const DASHBOARD_URL =
  process.env.DASHBOARD_URL || process.env.NEXT_PUBLIC_DASHBOARD_URL || '';

const clampLimit = (n: number | undefined, def: number, max: number) =>
  Math.min(Math.max(n ?? def, 1), max);

const toDate = (s?: string) => (s ? new Date(s) : undefined);

/** A profile by id (resolves anon/device ids to the canonical person first). */
export async function getProfileCore(input: { projectId: string; id: string }) {
  const { canonicalProfileId, aliases, isAnonymousAlias } =
    await resolveIdentityCore(input);
  const profile = await getProfileById(canonicalProfileId, input.projectId);
  return {
    id: canonicalProfileId,
    resolvedFrom: isAnonymousAlias ? input.id : undefined,
    aliases,
    profile: profile
      ? {
          firstName: profile.firstName,
          lastName: profile.lastName,
          email: profile.email,
          createdAt: profile.createdAt,
          properties: profile.properties,
        }
      : null,
  };
}

/** Chronological event list, optionally for one user (identity-unified). */
export async function listEventsCore(input: {
  projectId: string;
  profileId?: string;
  events?: string[];
  startDate?: string;
  endDate?: string;
  limit?: number;
  unifyIdentity?: boolean;
}) {
  let profileId = input.profileId;
  let profileIds: string[] | undefined;
  if (input.profileId && input.unifyIdentity !== false) {
    const r = await resolveIdentityCore({
      projectId: input.projectId,
      id: input.profileId,
    });
    profileIds = [r.canonicalProfileId, ...r.aliases];
    profileId = undefined;
  }
  const items = await getEventList({
    projectId: input.projectId,
    profileId,
    profileIds,
    events: input.events ?? null,
    take: clampLimit(input.limit, 50, 500),
    startDate: toDate(input.startDate),
    endDate: toDate(input.endDate),
  });
  return {
    events: items.map((e) => ({
      name: e.name,
      createdAt: e.createdAt,
      sessionId: e.sessionId,
      path: e.properties?.__path ?? undefined,
      country: e.country,
      properties: e.properties,
    })),
  };
}

/** Sessions for a project or one user (optionally only ones with a replay). */
export async function getSessionsCore(input: {
  projectId: string;
  profileId?: string;
  onlyReplays?: boolean;
  startDate?: string;
  endDate?: string;
  limit?: number;
}) {
  const { items } = await getSessionList({
    projectId: input.projectId,
    profileId: input.profileId,
    onlyReplays: input.onlyReplays,
    take: clampLimit(input.limit, 25, 200),
    startDate: toDate(input.startDate),
    endDate: toDate(input.endDate),
  });
  return { sessions: items };
}

/** Build the dashboard deep-link to a session's replay player. */
function replayLink(
  organizationId: string,
  projectId: string,
  sessionId: string,
) {
  return `${DASHBOARD_URL}/${organizationId}/${projectId}/session-replays/?session=${sessionId}`;
}

/**
 * Session replay links. By sessionId → one link (if a recording exists); by
 * profileId → that user's recent sessions that have a replay, each with a link.
 * Returns links only, never the recording data. Coverage isn't 100%.
 */
export async function getSessionReplayCore(input: {
  projectId: string;
  organizationId: string;
  sessionId?: string;
  profileId?: string;
  limit?: number;
}) {
  if (input.sessionId) {
    const res = await chMcp.query({
      query: `SELECT count() AS c FROM ${TABLE_NAMES.session_replay_chunks}
        WHERE project_id = ${esc(input.projectId)} AND session_id = ${esc(input.sessionId)}`,
      format: 'JSONEachRow',
    });
    const has = Number((await res.json<{ c: string }>())[0]?.c ?? 0) > 0;
    return has
      ? {
          sessionId: input.sessionId,
          replayUrl: replayLink(
            input.organizationId,
            input.projectId,
            input.sessionId,
          ),
        }
      : {
          sessionId: input.sessionId,
          replayUrl: null,
          note: 'No replay recording exists for this session.',
        };
  }

  // by user: sessions that have a replay
  const { items } = await getSessionList({
    projectId: input.projectId,
    profileId: input.profileId,
    onlyReplays: true,
    take: clampLimit(input.limit, 10, 50),
  });
  return {
    replays: items.map((s) => ({
      sessionId: s.id,
      startedAt: s.createdAt,
      durationSeconds: Math.round(s.duration / 1000), // s.duration is ms
      replayUrl: replayLink(input.organizationId, input.projectId, s.id),
    })),
  };
}

/**
 * Full journey for a user id — fork differentiator. Resolves the id to its
 * canonical person (unifying pre/post-login), then returns their profile,
 * recent sessions (with replay links where present), and a chronological event
 * timeline across ALL their anon + identified ids.
 */
export async function getUserJourneyCore(input: {
  projectId: string;
  organizationId: string;
  id: string;
  startDate?: string;
  endDate?: string;
  eventLimit?: number;
}) {
  const identity = await resolveIdentityCore({
    projectId: input.projectId,
    id: input.id,
  });
  const profileIds = [identity.canonicalProfileId, ...identity.aliases];

  const [profile, events, sessionRes] = await Promise.all([
    getProfileById(identity.canonicalProfileId, input.projectId),
    getEventList({
      projectId: input.projectId,
      profileIds,
      events: null,
      take: clampLimit(input.eventLimit, 100, 500),
      startDate: toDate(input.startDate),
      endDate: toDate(input.endDate),
    }),
    getSessionList({
      projectId: input.projectId,
      profileId: identity.canonicalProfileId,
      take: 25,
      startDate: toDate(input.startDate),
      endDate: toDate(input.endDate),
    }),
  ]);

  return {
    canonicalProfileId: identity.canonicalProfileId,
    aliases: identity.aliases,
    profile: profile
      ? {
          firstName: profile.firstName,
          email: profile.email,
          createdAt: profile.createdAt,
        }
      : null,
    // The count of the most-recent sessions fetched (capped at 25) — NOT the
    // user's lifetime session total.
    recentSessionCount: sessionRes.items.length,
    sessions: sessionRes.items.slice(0, 10).map((s) => ({
      sessionId: s.id,
      startedAt: s.createdAt,
      durationSeconds: Math.round(s.duration / 1000), // s.duration is ms
      replayUrl: s.hasReplay
        ? replayLink(input.organizationId, input.projectId, s.id)
        : undefined,
    })),
    timeline: events.map((e) => ({
      name: e.name,
      createdAt: e.createdAt,
      sessionId: e.sessionId,
    })),
  };
}

/**
 * Time-series insights for one or more events (the dashboard "insights"/linear
 * chart), collapsed to a model-sized summary.
 *
 * Wraps the fork's chart engine (`executeChart` — the same pipeline the
 * dashboard `chart.chart` tRPC procedure runs), so the numbers carry the fork's
 * identity resolution, materialized-column routing and events-table reads.
 * Runs on the ambient `mcp_ro` client (the MCP layer wraps every tool in
 * `runWithMcpClient`), so all reads beneath the engine are read-only.
 *
 * `metric: 'count'` counts events; `metric: 'unique'` counts unique users
 * (the two-level `user` segment). An optional `breakdown` splits each event
 * into one series per property value; optional `filters` narrow the whole query.
 */
export async function getInsightsCore(input: {
  projectId: string;
  startDate: string;
  endDate: string;
  events: string[];
  metric?: 'count' | 'unique';
  interval?: 'day' | 'week' | 'month';
  breakdown?: string;
  filters?: Array<{
    name: string;
    operator: IChartEventFilter['operator'];
    value?: (string | number | boolean | null)[];
  }>;
  /** Max series to return (relevant with a breakdown). */
  limit?: number;
}) {
  await assertEventNamesExist(input.projectId, input.events);

  const segment = input.metric === 'unique' ? 'user' : 'event';
  const interval = input.interval ?? 'day';
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

  const series = input.events.map((name, index) => ({
    id: String(index + 1),
    type: 'event' as const,
    name,
    displayName: name,
    segment,
    filters: [] as IChartEventFilter[],
  }));

  const globalFilters = (input.filters ?? []).map((f, index) => ({
    id: String(index),
    name: f.name,
    operator: f.operator,
    value: f.value ?? [],
  }));

  const chart = await executeChart({
    projectId: input.projectId,
    chartType: 'linear',
    interval,
    range: 'custom',
    startDate: input.startDate,
    endDate: input.endDate,
    series,
    breakdowns: input.breakdown ? [{ id: '0', name: input.breakdown }] : [],
    globalFilters,
    cohortFilters: [],
    holdProperties: [],
    previous: false,
    metric: 'sum',
    limit,
    sortOrder: 'desc',
    measuring: 'conversion_rate',
  } as unknown as IChartInput);

  // Build a shared date axis (the engine fills gaps, so all series align).
  const dates = chart.series[0]?.data.map((d) => d.date) ?? [];

  // One row per returned series: [name, total, ...per-interval counts], ranked
  // by total so a breakdown's head is first. The dashboard renders these as
  // lines; here we hand back the raw per-interval numbers, capped by `limit`.
  const rows = chart.series
    .map((serie) => {
      const row: Record<string, unknown> = {
        series: serie.names.join(' / '),
        total: serie.metrics.sum,
      };
      dates.forEach((date, i) => {
        row[date] = serie.data[i]?.count ?? 0;
      });
      return row as { series: string; total: number } & Record<string, number>;
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);

  return {
    events: input.events,
    metric: input.metric ?? 'count',
    interval,
    startDate: input.startDate,
    endDate: input.endDate,
    breakdown: input.breakdown,
    dates,
    overall: {
      total: chart.metrics.sum,
      average: chart.metrics.average,
      min: chart.metrics.min,
      max: chart.metrics.max,
    },
    series: rows,
    seriesReturned: rows.length,
    totalSeries: chart.series.length,
  };
}

/**
 * Active users per interval (DAU / WAU / MAU) over a date range, from `dau_mv`
 * (the same materialized view the dashboard's active-users widgets read).
 *
 * `interval: 'day'|'week'|'month'` selects DAU/WAU/MAU. "Active user" = a
 * distinct tracked profile id that fired at least one event in the bucket
 * (includes anonymous/device ids, exactly like the dashboard figure).
 * `uniqMerge` correctly merges the per-day `uniqState` states across a bucket.
 * Optionally returns the top events over the range (a range-scoped scan of the
 * events table, capped by the read-only client's execution limit).
 */
export async function getActiveUsersCore(input: {
  projectId: string;
  startDate: string;
  endDate: string;
  interval?: 'day' | 'week' | 'month';
  includeTopEvents?: boolean;
  topEventsLimit?: number;
}) {
  const interval = input.interval ?? 'day';
  const pid = esc(input.projectId);
  const start = esc(input.startDate.slice(0, 10));
  const end = esc(input.endDate.slice(0, 10));

  const bucketExpr =
    interval === 'week'
      ? 'toStartOfWeek(date)'
      : interval === 'month'
        ? 'toStartOfMonth(date)'
        : 'date';

  const dateRange = `date BETWEEN toDate(${start}) AND toDate(${end})`;

  const seriesRes = await chMcp.query({
    query: `SELECT ${bucketExpr} AS bucket, uniqMerge(profile_id) AS users
      FROM ${TABLE_NAMES.dau_mv}
      WHERE project_id = ${pid} AND ${dateRange}
      GROUP BY bucket ORDER BY bucket ASC`,
    format: 'JSONEachRow',
  });
  const seriesRows = (
    await seriesRes.json<{ bucket: string; users: string }>()
  ).map((r) => ({ bucket: r.bucket, users: Number(r.users) }));

  // Unique users across the WHOLE range (not the sum of buckets — a user active
  // on two days is one range-unique user but two DAUs).
  const totalRes = await chMcp.query({
    query: `SELECT uniqMerge(profile_id) AS users
      FROM ${TABLE_NAMES.dau_mv}
      WHERE project_id = ${pid} AND ${dateRange}`,
    format: 'JSONEachRow',
  });
  const totalUniqueUsers = Number(
    (await totalRes.json<{ users: string }>())[0]?.users ?? 0,
  );

  const counts = seriesRows.map((r) => r.users);
  const peak = seriesRows.reduce<{ bucket: string; users: number } | null>(
    (best, r) => (best === null || r.users > best.users ? r : best),
    null,
  );

  let topEvents:
    | Array<{ name: string; events: number; users: number }>
    | undefined;
  if (input.includeTopEvents) {
    const limit = Math.min(Math.max(input.topEventsLimit ?? 10, 1), 50);
    const topRes = await chMcp.query({
      query: `SELECT name, count() AS events, uniqExact(profile_id) AS users
        FROM ${TABLE_NAMES.events}
        WHERE project_id = ${pid}
          AND created_at BETWEEN toDate(${start}) AND toDate(${end}) + 1
        GROUP BY name ORDER BY events DESC LIMIT ${limit}`,
      format: 'JSONEachRow',
    });
    topEvents = (
      await topRes.json<{ name: string; events: string; users: string }>()
    ).map((r) => ({
      name: r.name,
      events: Number(r.events),
      users: Number(r.users),
    }));
  }

  return {
    interval,
    startDate: input.startDate,
    endDate: input.endDate,
    metricName:
      interval === 'week' ? 'WAU' : interval === 'month' ? 'MAU' : 'DAU',
    totalUniqueUsers,
    averageActiveUsersPerBucket:
      counts.length > 0
        ? Math.round(counts.reduce((a, b) => a + b, 0) / counts.length)
        : 0,
    peak,
    series: seriesRows,
    ...(topEvents ? { topEvents } : {}),
  };
}
