import sqlstring from 'sqlstring';
import { TABLE_NAMES, chMcp } from '../clickhouse/client';

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
