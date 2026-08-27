import sqlstring from 'sqlstring';
import type {
  CohortDefinition,
  EventBasedCohortDefinition,
  EventCriteria,
  Frequency,
  PropertyBasedCohortDefinition,
  Timeframe,
} from '@openpanel/validation';
import type { IChartEventFilter } from '@openpanel/validation';

import {
  ch,
  chQuery,
  TABLE_NAMES,
  aliasResolutionNeedsCte,
  resolvedPersonIdSql,
  resolvedProfileIdSql,
} from '../clickhouse/client';
import { db } from '../prisma-client';
import { operatorClause } from './filter-operators';

// v2 property MV (profile_event_property_summary_v2) is anon-inclusive but only
// backfilled from this date forward; June/pre-July is dirty/partial. Property
// cohorts whose timeframe STARTS on/after this route to v2 (all projects); older
// ones fall back to the anon-excluded v1 MV. Env-overridable coverage date.
const COHORTS_V2_START_DATE = process.env.COHORTS_V2_START_DATE || '2026-07-01';

/**
 * Build time constraint SQL from timeframe
 */
function buildTimeConstraint(timeframe: Timeframe): string {
  if (timeframe.type === 'relative') {
    // Parse relative time like "30d", "90d"
    const match = timeframe.value.match(/^(\d+)d$/);
    if (!match) {
      throw new Error(`Invalid relative timeframe: ${timeframe.value}`);
    }
    const days = Number.parseInt(match[1]!, 10);
    return `created_at >= now() - INTERVAL ${days} DAY`;
  } else {
    // Absolute time: start date and optional end date
    const start = timeframe.start;
    const end = timeframe.end || 'now()';

    if (timeframe.end) {
      return `created_at BETWEEN toDate('${start}') AND toDate('${end}')`;
    } else {
      // "Since date" - no end date
      return `created_at >= toDate('${start}')`;
    }
  }
}

/**
 * The UTC start day of a criterion's timeframe. Relative "Nd" resolves to
 * N days before today; absolute uses its `start`. Used only to gate v1 vs v2.
 */
function criteriaTimeframeStart(timeframe: Timeframe): Date {
  if (timeframe.type === 'relative') {
    const match = timeframe.value.match(/^(\d+)d$/);
    const days = match ? Number.parseInt(match[1]!, 10) : 0;
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d;
  }
  return new Date(`${timeframe.start}T00:00:00Z`);
}

/**
 * Property cohorts route to the anon-inclusive v2 MV only when the whole
 * timeframe sits within v2's coverage window (start >= COHORTS_V2_START_DATE);
 * otherwise fall back to v1 so we never read a partial/absent v2 range.
 */
function canRouteCohortToV2(criteria: EventCriteria): boolean {
  const start = criteriaTimeframeStart(criteria.timeframe);
  const gate = new Date(`${COHORTS_V2_START_DATE}T00:00:00Z`);
  return start.getTime() >= gate.getTime();
}

/**
 * Convert frequency operator to SQL comparison
 */
function getFrequencyOperator(frequency: Frequency): string {
  switch (frequency.operator) {
    case 'at_least':
      return `>= ${frequency.count}`;
    case 'exactly':
      return `= ${frequency.count}`;
    case 'at_most':
      return `<= ${frequency.count}`;
    default:
      return `>= ${frequency.count}`;
  }
}

/**
 * Build ClickHouse query for a single event criteria
 */
export function buildEventCriteriaQuery(
  projectId: string,
  criteria: EventCriteria,
  profileIdPrefilter?: string,
  // When true (and the alias dict is loaded), the membership emits the
  // CANONICAL person id instead of the raw profile_id, so a cohort JOINed onto
  // an identity-resolved funnel/chart/conversion lines up on the same identity
  // space (anon device -> firebase). Gated on the dict being ON: resolved*Sql
  // returns a self-contained dictGet only then; with the dict off it references
  // an `al` CTE that these standalone subqueries don't have, so we keep raw ids.
  // Left false for standalone cohort computation (cohort_members / counts) to
  // avoid changing stored membership.
  resolveIdentity = false,
): string {
  const { name, filters, timeframe, frequency } = criteria;

  // Build time constraint
  const timeConstraint = buildTimeConstraint(timeframe);

  const resolve = resolveIdentity && !aliasResolutionNeedsCte();
  // Events carry device_id (the alias key) -> resolve via device_id, fall back
  // to profile_id. QUALIFY the raw columns with the table name: the SELECT
  // aliases the resolved expr `AS profile_id`, and an unqualified `profile_id`
  // inside the coalesce would bind to that output alias (circular) — which in a
  // GROUP BY branch throws NOT_AN_AGGREGATE (the SELECT's raw col ends up not
  // matching the GROUP BY key). Qualifying (events.profile_id) makes both sides
  // the identical, unambiguous raw-column expression. Same pattern the
  // conversion service uses.
  const E = TABLE_NAMES.events;
  const eventsPid = resolve
    ? resolvedPersonIdSql(projectId, `${E}.device_id`, `${E}.profile_id`)
    : 'profile_id';
  // Caller-supplied prefilter shrinks the scan to a known small profile set
  // (e.g. start_events_raw in conversion charts) before the GROUP BY. When we
  // resolve, the prefilter set is the caller's RESOLVED ids (conversion's
  // start_events_raw already emits resolved), so we compare the resolved expr —
  // comparing raw profile_id would drop anon rows and under-match. When not
  // resolving, compare raw profile_id (indexed → granule skipping).
  const eventsPrefilter = profileIdPrefilter
    ? `AND ${eventsPid} IN (${profileIdPrefilter})`
    : '';
  // The property-summary MV has NO device_id column, so resolve via profile_id
  // (valid post-2026-08-24: proxy #107 made anon profile_id == $device_id ==
  // alias key). `mvPid`/`mvPrefilter` are computed inside the property branch
  // below, once the concrete `propertyTable` (v1 vs v2) is known, so the raw
  // column can be qualified with that table.

  // Check if there are event property filters
  const hasEventPropertyFilters = filters.some(
    (f) => f.name.startsWith('properties.') && !f.name.startsWith('profile.properties.')
  );

  // PROPERTY criteria ("did X where flag=Y").
  //   - v2 window  → anon-inclusive `profile_event_property_summary_v2` MV
  //     (exploded property_key/property_value schema, fast).
  //   - pre-v2     → the v1 property MV is RETIRED (anon-EXCLUDING, `profile_id
  //     != device_id`). Fall through to raw `events` with a `properties[key]`
  //     Map predicate: anon-inclusive and correct, never the undercounting v1 MV.
  if (hasEventPropertyFilters) {
    const propertyFilters = filters.filter((f) =>
      f.name.startsWith('properties.'),
    );

    if (canRouteCohortToV2(criteria)) {
      const propertyTable = TABLE_NAMES.profile_event_property_summary_v2;
      // Resolve via profile_id, QUALIFIED with the concrete propertyTable so the
      // raw column can't bind to the `AS profile_id` output alias (see eventsPid).
      const mvPid = resolve
        ? resolvedProfileIdSql(projectId, `${propertyTable}.profile_id`)
        : 'profile_id';
      const mvPrefilter = profileIdPrefilter
        ? `AND ${mvPid} IN (${profileIdPrefilter})`
        : '';

      // One `(property_key = k AND <value predicate>)` per filter, OR'd together.
      // operatorClause handles ALL operators (contains/doesNotContain/gt/regex/…).
      const propertyConditions = propertyFilters
        .map((filter) => {
          const propertyKey = filter.name.replace('properties.', '');
          const { value, operator } = filter;
          return `(property_key = ${sqlstring.escape(propertyKey)} AND ${operatorClause('property_value', operator, value)})`;
        })
        .join(' OR ');

      if (frequency) {
        const frequencyOp = getFrequencyOperator(frequency);
        return `
        SELECT ${mvPid} AS profile_id
        FROM ${propertyTable}
        WHERE project_id = ${sqlstring.escape(projectId)}
          AND name = ${sqlstring.escape(name)}
          AND ${timeConstraint.replace('created_at', 'event_date')}
          AND (${propertyConditions})
          ${mvPrefilter}
        GROUP BY ${mvPid}
        HAVING countMerge(event_count) ${frequencyOp}
      `;
      }

      return `
      SELECT DISTINCT ${mvPid} AS profile_id
      FROM ${propertyTable}
      WHERE project_id = ${sqlstring.escape(projectId)}
        AND name = ${sqlstring.escape(name)}
        AND ${timeConstraint.replace('created_at', 'event_date')}
        AND (${propertyConditions})
        ${mvPrefilter}
    `;
    }

    // Pre-v2 window: retired v1 MV → raw events + `properties[key]` predicate.
    // Same operatorClause, but the column is the events `properties` Map access
    // (values are stored identically — e.g. JSON-quoted `"base"`). Uses
    // created_at + plain count() for frequency (no event_date/countMerge).
    const eventsPropertyConditions = propertyFilters
      .map((filter) => {
        const propertyKey = filter.name.replace('properties.', '');
        const { value, operator } = filter;
        return `(${operatorClause(`properties[${sqlstring.escape(propertyKey)}]`, operator, value)})`;
      })
      .join(' OR ');

    if (frequency) {
      const frequencyOp = getFrequencyOperator(frequency);
      return `
        SELECT ${eventsPid} AS profile_id
        FROM ${TABLE_NAMES.events}
        WHERE project_id = ${sqlstring.escape(projectId)}
          AND name = ${sqlstring.escape(name)}
          AND ${timeConstraint}
          AND (${eventsPropertyConditions})
          ${eventsPrefilter}
        GROUP BY ${eventsPid}
        HAVING count() ${frequencyOp}
      `;
    }

    return `
      SELECT DISTINCT ${eventsPid} AS profile_id
      FROM ${TABLE_NAMES.events}
      WHERE project_id = ${sqlstring.escape(projectId)}
        AND name = ${sqlstring.escape(name)}
        AND ${timeConstraint}
        AND (${eventsPropertyConditions})
        ${eventsPrefilter}
    `;
  }

  // NAME-ONLY criteria ("did X", any N×) → raw events. The property MV explodes
  // each event into one row per property (ARRAY JOIN), so countMerge over it
  // massively overcounts frequency; and cohort_events_mv is anon-excluded. Raw
  // events is exact for any frequency, anon-inclusive, and faster than v2 here
  // (name is an effective sort-key prefix via the proj_funnel projection). Uses
  // created_at + plain count() — no event_date/countMerge rewrite.
  if (frequency) {
    const frequencyOp = getFrequencyOperator(frequency);

    return `
      SELECT ${eventsPid} AS profile_id
      FROM ${TABLE_NAMES.events}
      WHERE project_id = ${sqlstring.escape(projectId)}
        AND name = ${sqlstring.escape(name)}
        AND ${timeConstraint}
        ${eventsPrefilter}
      GROUP BY ${eventsPid}
      HAVING count() ${frequencyOp}
    `;
  }

  // For simple "did event" queries
  return `
    SELECT DISTINCT ${eventsPid} AS profile_id
    FROM ${TABLE_NAMES.events}
    WHERE project_id = ${sqlstring.escape(projectId)}
      AND name = ${sqlstring.escape(name)}
      AND ${timeConstraint}
      ${eventsPrefilter}
  `;
}

/**
 * Build ClickHouse query for property-based cohort
 * Returns a SELECT query string that can be embedded as a subquery
 */
export function buildPropertyBasedCohortQuery(
  projectId: string,
  definition: PropertyBasedCohortDefinition,
  profileIdPrefilter?: string,
  resolveIdentity = false,
): string {
  const { properties, operator } = definition.criteria;
  const resolve = resolveIdentity && !aliasResolutionNeedsCte();
  // profiles table has no device_id -> resolve the profile id itself.
  const idExpr = resolve ? resolvedProfileIdSql(projectId, 'id') : 'id';

  // Build property filters
  const filterWhere = getProfileFiltersWhereClause(properties);
  const filterClauses = Object.values(filterWhere);

  if (filterClauses.length === 0) {
    return `SELECT id as profile_id FROM ${TABLE_NAMES.profiles} FINAL WHERE 1=0`; // Empty result
  }

  const filterClause = filterClauses.join(
    operator === 'and' ? ' AND ' : ' OR ',
  );

  const prefilterClause = profileIdPrefilter
    ? `AND ${idExpr} IN (${profileIdPrefilter})`
    : '';

  return `
    SELECT ${idExpr} as profile_id
    FROM ${TABLE_NAMES.profiles} FINAL
    WHERE project_id = ${sqlstring.escape(projectId)}
      AND (${filterClause})
      ${prefilterClause}
  `;
}

/**
 * Compute event-based cohort membership
 * Returns array of profile IDs that match the criteria
 * @param limit - Optional limit on number of profiles (default: no limit)
 */
export async function computeEventBasedCohort(
  projectId: string,
  definition: EventBasedCohortDefinition,
  limit?: number,
): Promise<string[]> {
  const { events, operator } = definition.criteria;

  // Resolve to canonical person so a cohort's member list/count merges a user's
  // anon + identified ids into ONE person (matches the resolved funnel/conversion
  // usage). Gated dict-on inside the builder. INTERSECT/UNION over resolved sets
  // is still correct (resolved persons in all / any criteria).
  const queries = events.map((eventCriteria) => {
    return buildEventCriteriaQuery(projectId, eventCriteria, undefined, true);
  });

  // Combine queries based on AND/OR operator
  const combinedQuery =
    operator === 'and'
      ? queries.join(' INTERSECT ')
      : queries.join(' UNION DISTINCT ');

  // Apply limit in SQL query itself to prevent loading too much into memory
  const finalQuery = limit ? `${combinedQuery} LIMIT ${limit}` : combinedQuery;

  const results = await chQuery<{ profile_id: string }>(finalQuery);
  return results.map((r) => r.profile_id);
}

/**
 * Count cohort members without loading into memory
 * Used for dynamic cohorts and previews
 */
export async function countEventBasedCohort(
  projectId: string,
  definition: EventBasedCohortDefinition,
): Promise<number> {
  const { events, operator } = definition.criteria;

  // Resolve to canonical person (see computeEventBasedCohort) so the count is
  // per-person, not per raw anon/identified id.
  const queries = events.map((eventCriteria) => {
    return buildEventCriteriaQuery(projectId, eventCriteria, undefined, true);
  });

  // Combine queries based on AND/OR operator
  const combinedQuery =
    operator === 'and'
      ? queries.join(' INTERSECT ')
      : queries.join(' UNION DISTINCT ');

  // Use COUNT instead of loading all IDs - prevents OOM
  const countQuery = `SELECT count() as count FROM (${combinedQuery})`;
  const results = await chQuery<{ count: number }>(countQuery);
  return results[0]?.count ?? 0;
}

/**
 * Build profile filter WHERE clause
 * Similar to getEventFiltersWhereClause but for profiles table
 */
function getProfileFiltersWhereClause(
  filters: IChartEventFilter[],
): Record<string, string> {
  const where: Record<string, string> = {};

  filters.forEach((filter, index) => {
    const id = `pf${index}`;
    const { name, value, operator } = filter;

    if (
      value.length === 0 &&
      operator !== 'isNull' &&
      operator !== 'isNotNull'
    ) {
      return;
    }

    // Determine the column access pattern
    // Replace profile. with profiles. since we're querying the profiles table directly
    const normalizedName = name.replace(/^profile\./, 'profiles.');
    let columnAccess: string;

    if (normalizedName.startsWith('profiles.properties.')) {
      const propKey = normalizedName.replace('profiles.properties.', '');
      columnAccess = `profiles.properties['${propKey}']`;
    } else {
      // For profiles.email, profiles.first_name, etc. or any other column
      columnAccess = normalizedName;
    }

    // Build WHERE clause based on operator
    switch (operator) {
      case 'is': {
        if (value.length === 1) {
          where[id] = `${columnAccess} = ${sqlstring.escape(String(value[0]).trim())}`;
        } else {
          where[id] = `${columnAccess} IN (${value
            .map((val) => sqlstring.escape(String(val).trim()))
            .join(', ')})`;
        }
        break;
      }
      case 'isNot': {
        if (value.length === 1) {
          where[id] = `${columnAccess} != ${sqlstring.escape(String(value[0]).trim())}`;
        } else {
          where[id] = `${columnAccess} NOT IN (${value
            .map((val) => sqlstring.escape(String(val).trim()))
            .join(', ')})`;
        }
        break;
      }
      case 'contains': {
        where[id] = `(${value
          .map((val) => `${columnAccess} LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`)
          .join(' OR ')})`;
        break;
      }
      case 'doesNotContain': {
        where[id] = `(${value
          .map((val) => `${columnAccess} NOT LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`)
          .join(' OR ')})`;
        break;
      }
      case 'startsWith': {
        where[id] = `(${value
          .map((val) => `${columnAccess} LIKE ${sqlstring.escape(`${String(val).trim()}%`)}`)
          .join(' OR ')})`;
        break;
      }
      case 'endsWith': {
        where[id] = `(${value
          .map((val) => `${columnAccess} LIKE ${sqlstring.escape(`%${String(val).trim()}`)}`)
          .join(' OR ')})`;
        break;
      }
      case 'isNull': {
        where[id] = `(${columnAccess} IS NULL OR ${columnAccess} = '')`;
        break;
      }
      case 'isNotNull': {
        where[id] = `(${columnAccess} IS NOT NULL AND ${columnAccess} != '')`;
        break;
      }
      case 'gt': {
        if (value[0] !== undefined) {
          where[id] = `toFloat64OrNull(${columnAccess}) > ${Number(value[0])}`;
        }
        break;
      }
      case 'lt': {
        if (value[0] !== undefined) {
          where[id] = `toFloat64OrNull(${columnAccess}) < ${Number(value[0])}`;
        }
        break;
      }
      case 'gte': {
        if (value[0] !== undefined) {
          where[id] = `toFloat64OrNull(${columnAccess}) >= ${Number(value[0])}`;
        }
        break;
      }
      case 'lte': {
        if (value[0] !== undefined) {
          where[id] = `toFloat64OrNull(${columnAccess}) <= ${Number(value[0])}`;
        }
        break;
      }
    }
  });

  return where;
}

/**
 * Compute property-based cohort membership
 */
export async function computePropertyBasedCohort(
  projectId: string,
  definition: PropertyBasedCohortDefinition,
  limit?: number,
): Promise<string[]> {
  const { properties, operator } = definition.criteria;

  // Build property filters
  const filterWhere = getProfileFiltersWhereClause(properties);
  const filterClauses = Object.values(filterWhere);

  if (filterClauses.length === 0) {
    return [];
  }

  const filterClause = filterClauses.join(
    operator === 'and' ? ' AND ' : ' OR ',
  );

  // Resolve profile id -> canonical person (dict-on) so a person with an anon +
  // identified profile counts once. DISTINCT collapses the merged ids.
  const resolve = !aliasResolutionNeedsCte();
  const idExpr = resolve
    ? resolvedProfileIdSql(projectId, `${TABLE_NAMES.profiles}.id`)
    : 'id';

  const query = `
    SELECT DISTINCT ${idExpr} as profile_id
    FROM ${TABLE_NAMES.profiles} FINAL
    WHERE project_id = ${sqlstring.escape(projectId)}
      AND (${filterClause})
    ${limit ? `LIMIT ${limit}` : ''}
  `;

  const results = await chQuery<{ profile_id: string }>(query);
  return results.map((r) => r.profile_id);
}

/**
 * Count property-based cohort members without loading into memory
 */
export async function countPropertyBasedCohort(
  projectId: string,
  definition: PropertyBasedCohortDefinition,
): Promise<number> {
  const { properties, operator } = definition.criteria;

  // Build property filters
  const filterWhere = getProfileFiltersWhereClause(properties);
  const filterClauses = Object.values(filterWhere);

  if (filterClauses.length === 0) {
    return 0;
  }

  const filterClause = filterClauses.join(
    operator === 'and' ? ' AND ' : ' OR ',
  );

  // Count distinct canonical persons (dict-on), not raw profile rows, so anon +
  // identified profiles of the same person count once.
  const resolve = !aliasResolutionNeedsCte();
  const countExpr = resolve
    ? `uniqExact(${resolvedProfileIdSql(projectId, `${TABLE_NAMES.profiles}.id`)})`
    : 'count()';

  const query = `
    SELECT ${countExpr} as count
    FROM ${TABLE_NAMES.profiles} FINAL
    WHERE project_id = ${sqlstring.escape(projectId)}
      AND (${filterClause})
  `;

  const results = await chQuery<{ count: number }>(query);
  return results[0]?.count ?? 0;
}

/**
 * Store cohort membership in ClickHouse
 */
export async function storeCohortMembership(
  projectId: string,
  cohortId: string,
  profileIds: string[],
  version: number,
): Promise<void> {
  if (profileIds.length === 0) return;

  // Use JSONEachRow format for better Map type handling
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const data = profileIds.map((profileId) => ({
    project_id: projectId,
    cohort_id: cohortId,
    profile_id: profileId,
    matched_at: now,
    matching_properties: {},
    version: version,
  }));

  await ch.insert({
    table: TABLE_NAMES.cohort_members,
    values: data,
    format: 'JSONEachRow',
  });

  // Update metadata
  const sampleProfiles = profileIds.slice(0, 10);
  await ch.insert({
    table: TABLE_NAMES.cohort_metadata,
    values: [{
      project_id: projectId,
      cohort_id: cohortId,
      member_count: profileIds.length,
      last_computed_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      sample_profiles: sampleProfiles,
      version: version,
    }],
    format: 'JSONEachRow',
  });
}

/**
 * Get cohort members with pagination
 */
export async function getCohortMembers(
  cohortId: string,
  projectId: string,
  opts?: { limit?: number; offset?: number },
): Promise<{ profileIds: string[]; total: number }> {
  const cohort = await db.cohort.findUnique({ where: { id: cohortId } });

  if (!cohort) {
    throw new Error('Cohort not found');
  }

  // If stored in ClickHouse, query from cohort_members table
  if (!cohort.computeOnDemand) {
    const query = `
      SELECT
        profile_id,
        count() OVER() as total
      FROM ${TABLE_NAMES.cohort_members} FINAL
      WHERE project_id = ${sqlstring.escape(projectId)}
        AND cohort_id = ${sqlstring.escape(cohortId)}
      ORDER BY matched_at DESC
      ${opts?.limit ? `LIMIT ${opts.limit}` : ''}
      ${opts?.offset ? `OFFSET ${opts.offset}` : ''}
    `;

    const results = await chQuery<{ profile_id: string; total: number }>(
      query,
    );
    return {
      profileIds: results.map((r) => r.profile_id),
      total: results[0]?.total || 0,
    };
  }

  // Otherwise, compute on-demand
  const definition = cohort.definition as CohortDefinition;
  const profileIds = await computeCohort(projectId, definition);

  return {
    profileIds: profileIds.slice(
      opts?.offset || 0,
      (opts?.offset || 0) + (opts?.limit || 50),
    ),
    total: profileIds.length,
  };
}

/**
 * Get cohort count
 */
export async function getCohortCount(
  cohortId: string,
  projectId: string,
): Promise<number> {
  const cohort = await db.cohort.findUnique({ where: { id: cohortId } });

  if (!cohort) {
    throw new Error('Cohort not found');
  }

  // Check if cached in PostgreSQL
  if (cohort.profileCount && cohort.lastComputedAt) {
    const age = Date.now() - cohort.lastComputedAt.getTime();
    if (age < 15 * 60 * 1000) {
      // 15 minutes
      return cohort.profileCount;
    }
  }

  // Query from ClickHouse
  if (!cohort.computeOnDemand) {
    const result = await chQuery<{ count: number }>(`
      SELECT count() as count
      FROM ${TABLE_NAMES.cohort_members} FINAL
      WHERE project_id = ${sqlstring.escape(projectId)}
        AND cohort_id = ${sqlstring.escape(cohortId)}
    `);
    return result[0]?.count || 0;
  }

  // Compute on-demand using COUNT query - don't load all profile IDs into memory
  const definition = cohort.definition as CohortDefinition;
  return await countCohort(projectId, definition);
}

/**
 * Main compute function - routes to correct implementation
 */
export async function computeCohort(
  projectId: string,
  definition: CohortDefinition,
  limit?: number,
): Promise<string[]> {
  if (definition.type === 'event') {
    return computeEventBasedCohort(projectId, definition, limit);
  } else if (definition.type === 'property') {
    return computePropertyBasedCohort(projectId, definition, limit);
  }
  return [];
}

/**
 * Count cohort members without loading into memory
 * Works for both event and property-based cohorts
 */
export async function countCohort(
  projectId: string,
  definition: CohortDefinition,
): Promise<number> {
  if (definition.type === 'event') {
    return countEventBasedCohort(projectId, definition);
  } else if (definition.type === 'property') {
    return countPropertyBasedCohort(projectId, definition);
  }
  return 0;
}

/**
 * Update cohort membership (for dynamic cohorts)
 */
export async function updateCohortMembership(
  cohortId: string,
): Promise<void> {
  const cohort = await db.cohort.findUnique({ where: { id: cohortId } });

  if (!cohort || cohort.isStatic || cohort.computeOnDemand) {
    return; // Skip static and on-demand cohorts
  }

  const definition = cohort.definition as CohortDefinition;
  // Limit static cohorts to 10K profiles to prevent OOM
  const profileIds = await computeCohort(cohort.projectId, definition, 10000);

  // Increment version for ReplacingMergeTree
  const version = Date.now();

  // Store new membership
  await storeCohortMembership(
    cohort.projectId,
    cohort.id,
    profileIds,
    version,
  );

  // Update cache in PostgreSQL
  await db.cohort.update({
    where: { id: cohortId },
    data: {
      profileCount: profileIds.length,
      lastComputedAt: new Date(),
    },
  });
}

/**
 * Get profiles in cohort as a Set (for filtering)
 */
export async function getProfilesInCohort(
  cohortId: string,
  projectId: string,
): Promise<Set<string>> {
  const { profileIds } = await getCohortMembers(cohortId, projectId, {
    limit: 100000, // Large limit for filtering
  });
  return new Set(profileIds);
}
