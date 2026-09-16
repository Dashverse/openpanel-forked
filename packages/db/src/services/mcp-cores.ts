import sqlstring from 'sqlstring';
import { TABLE_NAMES, chMcp } from '../clickhouse/client';
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
  const rows = await res.json<{ property_key: string; distinct_values: string }>();
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
  return { eventName: input.eventName, property: `properties.${key}`, values: rows.map((r) => r.value) };
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
  const aliases = (await aliasRes.json<{ alias: string }>()).map((r) => r.alias);

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
function replayLink(organizationId: string, projectId: string, sessionId: string) {
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
      ? { sessionId: input.sessionId, replayUrl: replayLink(input.organizationId, input.projectId, input.sessionId) }
      : { sessionId: input.sessionId, replayUrl: null, note: 'No replay recording exists for this session.' };
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
      durationSeconds: s.duration,
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
      ? { firstName: profile.firstName, email: profile.email, createdAt: profile.createdAt }
      : null,
    sessionCount: sessionRes.items.length,
    sessions: sessionRes.items.slice(0, 10).map((s) => ({
      sessionId: s.id,
      startedAt: s.createdAt,
      durationSeconds: s.duration,
      replayUrl: s.hasReplay ? replayLink(input.organizationId, input.projectId, s.id) : undefined,
    })),
    timeline: events.map((e) => ({
      name: e.name,
      createdAt: e.createdAt,
      sessionId: e.sessionId,
    })),
  };
}
