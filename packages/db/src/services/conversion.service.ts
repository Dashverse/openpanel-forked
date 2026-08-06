import { NOT_SET_VALUE } from '@openpanel/constants';
import type { IChartEvent, IChartInput } from '@openpanel/validation';
import { omit } from 'ramda';
import sqlstring from 'sqlstring';
import {
  TABLE_NAMES,
  ch,
  formatClickhouseDate,
  getEventsTableForRange,
  resolvedProfileIdSql,
  aliasResolutionNeedsCte,
} from '../clickhouse/client';
import { clix } from '../clickhouse/query-builder';
import {
  getEventFiltersWhereClause,
  getSelectPropertyKey,
  fetchCohortsMetadata,
  getCohortCteName,
  getCohortAlias,
  buildCohortMembershipQuery,
  getMaterializedColumns,
} from './chart.service';
import { onlyReportEvents } from './reports.service';
import { getCustomEventByName, expandCustomEventToSQL } from './custom-event.service';

const quoteCol = (col: string) => `\`${col.replace(/^`|`$/g, '')}\``;

export class ConversionService {
  constructor(private client: typeof ch) {}

  /**
   * Helper to build breakdown column with table alias
   * Handles property keys, profile fields, and cohort expressions
   */
  private getBreakdownColumnWithAlias(
    breakdownName: string,
    projectId: string,
    cohortId: string | undefined,
    tableAlias: string,
    cohortName?: string,
  ): string {
    const propertyKey = getSelectPropertyKey(breakdownName, projectId, cohortId, cohortName);

    // Cohort expressions already have their own aliases (e.g., cohort_abc123.profile_id)
    if (propertyKey.includes('cohort_') || propertyKey.startsWith('if(')) {
      return propertyKey;
    }

    // Profile fields are already qualified (e.g., profile.created_at)
    if (propertyKey.startsWith('profile.')) {
      return propertyKey;
    }

    // For property fields, prepend table alias
    // e.g., properties['key'] -> se.properties['key']
    if (propertyKey.startsWith('properties[') || propertyKey.includes('arrayMap')) {
      return `${tableAlias}.${propertyKey}`;
    }

    // For simple fields (e.g., name, country), prepend alias
    return `${tableAlias}.${propertyKey}`;
  }

  /**
   * Build CTE for a single event (start or end of funnel)
   * Handles both regular events and custom events
   */
  private async buildSingleEventCte(
    event: IChartEvent,
    cteName: string,
    projectId: string,
    startDate: string,
    endDate: string,
    extraColumns: string[] = [],
    groupCol: string,
    preFilterCte?: string,
    resolveProfile = false,
  ): Promise<string> {
    // Check if this is a custom event
    const customEvent = await getCustomEventByName(event.name, projectId);

    if (customEvent) {
      // Compute needed columns upfront and pass to expandCustomEventToSQL.
      // This skips SELECT * REPLACE entirely for the inner scan, allowing
      // ClickHouse to use proj_funnel instead of reading all columns from disk.
      // REPLACE is preserved for all other callers that don't pass selectColumns.
      const baseColumns = ['profile_id', 'session_id', 'created_at'];
      const neededColumns = [...new Set([...baseColumns, ...extraColumns])];

      const baseWhere = [
        `created_at >= toDateTime('${formatClickhouseDate(startDate)}')`,
        `created_at <= toDateTime('${formatClickhouseDate(endDate)}')`,
        `${groupCol} != ''`,
        ...(preFilterCte ? [`${groupCol} IN (SELECT ${groupCol} FROM ${preFilterCte})`] : []),
      ];

      const sql = await expandCustomEventToSQL(
        {
          name: customEvent.name,
          projectId,
          definition: customEvent.definition as any,
        },
        baseWhere,
        neededColumns,
      );

      return `${cteName} AS (${sql})`;
    } else {
      // Regular event - apply filters if present
      // Exclude cohort filters — they're handled via JOINs in the outer query
      const nonCohortFilters = (event.filters ?? []).filter(
        f => f.operator !== 'inCohort' && f.operator !== 'notInCohort'
      );
      const filterClauses = nonCohortFilters.length > 0
        ? Object.values(getEventFiltersWhereClause(nonCohortFilters, projectId))
        : [];
      const filterWhere = filterClauses.length > 0
        ? ' AND ' + filterClauses.join(' AND ')
        : '';

      // If any filter references profile.*, join the profiles table inside the CTE.
      // For profile.properties.X paths, extract the specific key as an aliased
      // column rather than pulling the whole `properties` Map — avoids name
      // collision with events.properties when a conversion mixes profile.* and
      // event-level properties.* filters. Matches the alias form returned by
      // getSelectPropertyKey for profile.properties.X.
      const profileFilters = (event.filters || []).filter(f => f.name.startsWith('profile.'));
      let profileJoinClause = '';
      if (profileFilters.length > 0) {
        const matCols = await getMaterializedColumns('profiles');
        const profileColumns = [...new Set(
          profileFilters.flatMap(f => {
            if (f.name.startsWith('profile.properties.')) {
              const cached = matCols[f.name];
              if (cached) {
                return [cached.replace('profile.', '')];
              }
              const key = f.name.replace('profile.properties.', '');
              return [`properties[${sqlstring.escape(key)}] AS \`properties.${key}\``];
            }
            return [f.name.replace('profile.', '').split('.')[0]!];
          })
        )];
        profileJoinClause = `\n        LEFT JOIN (SELECT id, ${profileColumns.join(', ')} FROM ${TABLE_NAMES.profiles} FINAL WHERE project_id = '${projectId}') AS profile ON profile.id = ${getEventsTableForRange(startDate)}.profile_id`;
      }

      // Minimal SELECT: only the columns actually needed downstream
      const baseColumns = ['profile_id', 'session_id', 'created_at'];
      const selectColumns = [...new Set([...baseColumns, ...extraColumns])];

      // Identity-merge resolution (allowlisted projects only — see getConversion).
      // Resolve profile_id -> canonical via the `al` CTE so an anon-start /
      // identified-end funnel stitches. `coalesce(nullIf(...))` guards CH's empty
      // -string LEFT JOIN default. When off, this is byte-identical to before.
      // Qualify the raw column as `events.profile_id` wherever it feeds the
      // resolution: an unqualified `profile_id` in the JOIN ON / coalesce binds to
      // the SELECT output alias (also `profile_id`), yielding a circular join key
      // (al.alias = coalesce(al.canonical, profile_id)) that ClickHouse rejects.
      const rawProfileId = `${getEventsTableForRange(startDate)}.profile_id`;
      // dict on -> dictGet (no JOIN); dict off -> al CTE + JOIN (unchanged).
      const aliasJoin =
        resolveProfile && aliasResolutionNeedsCte()
          ? `\n        LEFT JOIN al ON al.alias = ${rawProfileId}`
          : '';
      const profileIdExpr = resolveProfile
        ? resolvedProfileIdSql(projectId, rawProfileId)
        : null;
      const selectList = selectColumns
        .map((c) =>
          profileIdExpr && c === 'profile_id'
            ? `${profileIdExpr} AS \`profile_id\``
            : quoteCol(c),
        )
        .join(', ');
      // The prefilter (end ⊆ start) must compare RESOLVED ids on both sides:
      // start_events_raw already emits resolved profile_id, so the end CTE's LHS
      // must resolve too — otherwise raw-end never matches canonical-start.
      const preFilterLhs = profileIdExpr ?? groupCol;

      // project_id / name / created_at go into PREWHERE so ClickHouse can skip
      // granules using the sort key before loading other columns. The rest of
      // the predicates (groupCol != '', user filters, preFilterCte subquery)
      // stay in WHERE — they reference columns that PREWHERE can't help with
      // or depend on the profile LEFT JOIN executed after PREWHERE.
      return `${cteName} AS (
        SELECT ${selectList}
        FROM ${getEventsTableForRange(startDate)}${profileJoinClause}${aliasJoin}
        PREWHERE project_id = '${projectId}'
          AND name = '${event.name}'
          AND created_at >= toDateTime('${formatClickhouseDate(startDate)}')
          AND created_at <= toDateTime('${formatClickhouseDate(endDate)}')
        WHERE ${groupCol} != ''${filterWhere}${preFilterCte ? `\n          AND ${preFilterLhs} IN (SELECT ${groupCol} FROM ${preFilterCte})` : ''}
      )`;
    }
  }

  /**
   * Build events source for conversion query
   * Handles both regular events and custom events
   * Supports N events (not just 2)
   * @deprecated Use buildSingleEventCte instead for optimized self-join approach
   */
  private async buildEventsSource(
    events: IChartEvent[],
    projectId: string,
    startDate: string,
    endDate: string,
  ): Promise<{
    fromClause: string;
    ctes: string[];
    needsDateFilter: boolean;
  }> {
    // Check if any events are custom events
    const customEvents = await Promise.all(
      events.map(event => getCustomEventByName(event.name, projectId))
    );

    // If no custom events, use regular events table
    if (customEvents.every(ce => !ce)) {
      return {
        fromClause: getEventsTableForRange(startDate),
        ctes: [],
        needsDateFilter: true,
      };
    }

    // Get materialized columns to ensure UNION compatibility (events table only)
    const materializedColumns = await getMaterializedColumns('events');
    const materializedColumnNames = Object.values(materializedColumns);
    const materializedColumnsSelect = materializedColumnNames.length > 0
      ? `, ${materializedColumnNames.map(col => `\`${col}\``).join(', ')}`
      : '';

    // Build CTEs for custom events
    const ctes: string[] = [];
    const baseWhere = [
      `created_at >= toDateTime('${formatClickhouseDate(startDate)}')`,
      `created_at <= toDateTime('${formatClickhouseDate(endDate)}')`,
    ];

    // Build CTE for each custom event
    const customEventQueries = await Promise.all(
      customEvents.map(async (customEvent, index) => {
        if (customEvent) {
          const sql = await expandCustomEventToSQL(
            {
              name: customEvent.name,
              projectId,
              definition: customEvent.definition as any,
            },
            baseWhere,
          );
          return `custom_event_${index} AS (${sql})`;
        }
        return null;
      })
    );

    ctes.push(...customEventQueries.filter((q): q is string => q !== null));

    // Build union of custom and regular events
    const unionParts: string[] = [];

    events.forEach((event, index) => {
      if (customEvents[index]) {
        unionParts.push(`SELECT * FROM custom_event_${index}`);
      } else {
        // Regular event - include materialized columns to match custom events
        unionParts.push(`
          SELECT *${materializedColumnsSelect} FROM ${getEventsTableForRange(startDate)}
          WHERE project_id = '${projectId}'
            AND name = '${event.name}'
            AND created_at BETWEEN toDateTime('${startDate}') AND toDateTime('${endDate}')
        `);
      }
    });

    ctes.push(`combined_events AS (${unionParts.join(' UNION ALL ')})`);

    return {
      fromClause: 'combined_events',
      ctes,
      needsDateFilter: false, // Already filtered in CTEs
    };
  }

  /**
   * Single-scan array-aggregate SQL for the simple 2-event conversion case.
   * Mirrors PostHog's aggregate_funnel pattern in pure CH SQL — single
   * events scan with per-step arrays, arrayJoin for per-day cohort
   * attribution, arrayExists for in-window match (cross-day safe).
   */
  private buildArrayPatternSql({
    projectId,
    firstEvent,
    lastEvent,
    startDate,
    endDate,
    extendedEndDate,
    funnelWindowSeconds,
    interval,
    breakdown,
    limit,
  }: {
    projectId: string;
    firstEvent: IChartEvent;
    lastEvent: IChartEvent;
    startDate: string;
    endDate: string;
    extendedEndDate: string;
    funnelWindowSeconds: number;
    interval?: 'minute' | 'hour' | 'day' | 'week' | 'month';
    breakdown?: { name: string; cohortId?: string };
    limit?: number;
  }): string {
    const startTs = `toDateTime('${formatClickhouseDate(startDate)}')`;
    const endTs = `toDateTime('${formatClickhouseDate(endDate)}')`;
    const extendedEndTs = `toDateTime('${formatClickhouseDate(extendedEndDate)}')`;
    const projectLiteral = projectId.replace(/'/g, "''");
    const firstNameLiteral = firstEvent.name.replace(/'/g, "''");
    const lastNameLiteral = lastEvent.name.replace(/'/g, "''");
    // Bucket each open by the requested interval so we get one row per user
    // per bucket (hour / day / week / month). Previously bucketed by `toDate(o)`
    // and then re-bucketed with `toStartOfHour(toDate(...))`, which always
    // collapses hourly views to 00:00. See #368.
    //
    // `toDateTime(o)` normalizes to `DateTime` so the ORDER BY column type
    // matches the `WITH FILL FROM/TO` bounds (`clix.toStartOf(<toDateTime(...)>)`
    // returns DateTime). Same-type = no reliance on implicit DateTime64→DateTime
    // coercion for hour/minute, and label formatting is consistent everywhere.
    // `first_open` stays DateTime64(3) via `arrayMin(opens)` — window precision
    // preserved.
    const bucketInterval = interval || 'day';
    const bucketExpr = clix.toStartOf('toDateTime(o)', bucketInterval);

    // Ensure the result contains a row for every bucket in [startTs, endTs).
    // Without this, empty hour/minute buckets are omitted, and the resolver in
    // `packages/trpc/src/routers/chart.ts` (`previous?.[sIndex]?.data?.[dIndex]?.rate`)
    // aligns previous-period rates by array INDEX — a sparse current series
    // would pair to the wrong previous bucket. `WITH FILL` fills the gaps
    // server-side so downstream index-based pairing stays correct.
    //
    // Clamp `fillEnd` to `now()` so we don't fill BUCKETS THAT HAVEN'T HAPPENED
    // YET. For a "7D" range today, `endDate` = end-of-today = 23:59:59, so
    // without clamping WITH FILL would insert 0-count rows for every future
    // hour of today. Two visible symptoms this caused:
    //   1. Live charts showed a flat 0% line at the right edge (trailing
    //      future hours filled as 0).
    //   2. Hourly alerting queries (`apps/worker/src/jobs/cron.custom-alerts.ts`)
    //      pick `data[data.length - skipLast]` — the last future 0-bucket —
    //      and fired "current value is 0.00%" alerts against forecasted bands.
    // Historical ranges are unaffected (`least(pastDate, now())` = pastDate).
    const fillStart = clix.toStartOf(startTs, bucketInterval);
    const fillEnd = clix.toStartOf(`least(${endTs}, now())`, bucketInterval);
    const fillStep = `INTERVAL 1 ${bucketInterval.toUpperCase()}`;

    // Hoist event filters to a `filtered_profiles` pre-CTE so proj_funnel
    // stays selected for the main scan. Filters in groupArrayIf force CH
    // off proj_funnel for column reads (country isn't in the projection)
    // — measured 42s vs 4.4s for a 30-day country='US' funnel.
    //
    // Semantic: broader than per-event strict (a user with start event
    // matching AND end event not matching is included). This matches the
    // backend-country attribution case where backend events get pod-IP
    // country. Day-level counts can differ by ~0-1%.
    const collectFilterClauses = (event: IChartEvent): string[] => {
      const filters = event.filters ?? [];
      if (filters.length === 0) return [];
      return Object.values(getEventFiltersWhereClause(filters, projectId));
    };

    const firstFilterClauses = collectFilterClauses(firstEvent);
    const lastFilterClauses = collectFilterClauses(lastEvent);
    const allFilterClauses = [
      ...new Set([...firstFilterClauses, ...lastFilterClauses]),
    ];

    const filteredProfilesCte =
      allFilterClauses.length > 0
        ? `filtered_profiles AS (
        SELECT DISTINCT profile_id
        FROM ${getEventsTableForRange(startDate)}
        WHERE project_id = '${projectLiteral}'
          AND name IN ('${firstNameLiteral}', '${lastNameLiteral}')
          AND created_at >= ${startTs}
          AND created_at <= ${extendedEndTs}
          AND profile_id != ''
          AND ${allFilterClauses.join(' AND ')}
      ),`
        : '';

    const E = getEventsTableForRange(startDate);

    const filteredProfilesJoin =
      allFilterClauses.length > 0
        ? `\n          AND ${E}.profile_id IN (SELECT profile_id FROM filtered_profiles)`
        : '';

    // Alias resolution: dictGet (in-RAM, no al CTE/JOIN) when PROFILE_ALIAS_DICT
    // is set; otherwise the al CTE + LEFT JOIN — byte-identical to before. See
    // client.ts resolvedProfileIdSql / aliasResolutionNeedsCte.
    const aliasCte = aliasResolutionNeedsCte()
      ? `al AS (
        SELECT alias, argMax(profile_id, created_at) AS canonical
        FROM ${TABLE_NAMES.alias}
        WHERE project_id = '${projectLiteral}'
        GROUP BY alias
      ),
      `
      : '';
    const aliasJoin = aliasResolutionNeedsCte()
      ? `\n        LEFT JOIN al ON al.alias = ${E}.profile_id`
      : '';
    const resolvedPid = resolvedProfileIdSql(projectId, `${E}.profile_id`);

    // Split-scan breakdown variant. Opens (first event) are grouped per
    // (resolved_pid, b_0) so the breakdown value comes from the START event;
    // finishes (last event) are grouped per user only, so conversion is decided
    // on the user — NOT pinned to the finish's breakdown value (which is often
    // empty/different). Matches the ASOF path's "convert on the user" semantic +
    // its dense_rank top-N breakdown limiting. See docs/conversion-chart-perf.md.
    if (breakdown) {
      const breakdownExpr = getSelectPropertyKey(
        breakdown.name,
        projectId,
        undefined,
      );
      const topNLimit = limit ?? 50;
      return `
      WITH ${filteredProfilesCte}${aliasCte}user_installs AS (
        SELECT
          ${resolvedPid} AS resolved_pid,
          ${breakdownExpr} AS b_0,
          groupArray(toDateTime64(created_at, 3)) AS opens
        FROM ${E}${aliasJoin}
        WHERE project_id = '${projectLiteral}'
          AND name = '${firstNameLiteral}'
          AND created_at >= ${startTs}
          AND created_at <= ${endTs}
          AND ${E}.profile_id != ''${filteredProfilesJoin}
        GROUP BY resolved_pid, b_0
        HAVING length(opens) > 0
      ),
      user_finishes AS (
        SELECT
          ${resolvedPid} AS resolved_pid,
          groupArray(toDateTime64(created_at, 3)) AS finishes
        FROM ${E}${aliasJoin}
        WHERE project_id = '${projectLiteral}'
          AND name = '${lastNameLiteral}'
          AND created_at >= ${startTs}
          AND created_at <= ${extendedEndTs}
          AND ${E}.profile_id != ''
        GROUP BY resolved_pid
      ),
      per_user_per_bucket AS (
        SELECT
          ui.b_0 AS b_0,
          arrayJoin(arrayDistinct(arrayMap(o -> ${bucketExpr}, ui.opens))) AS open_bucket,
          arrayMin(arrayFilter(o -> ${bucketExpr} = open_bucket, ui.opens)) AS first_open,
          uf.finishes AS finishes
        FROM user_installs ui
        LEFT JOIN user_finishes uf ON uf.resolved_pid = ui.resolved_pid
      ),
      agg AS (
        SELECT
          open_bucket AS event_day,
          b_0,
          count() AS total_first,
          countIf(arrayExists(
            f -> f >= first_open AND f <= first_open + INTERVAL ${funnelWindowSeconds} SECOND,
            finishes
          )) AS conversions,
          round(
            100.0 * countIf(arrayExists(
              f -> f >= first_open AND f <= first_open + INTERVAL ${funnelWindowSeconds} SECOND,
              finishes
            )) / count(),
            2
          ) AS conversion_rate_percentage
        FROM per_user_per_bucket
        GROUP BY event_day, b_0
      )
      SELECT event_day, b_0, total_first, conversions, conversion_rate_percentage
      FROM (
        SELECT *, dense_rank() OVER (ORDER BY _bucket_rate DESC) AS _bucket_rank
        FROM (
          SELECT *, avg(conversion_rate_percentage) OVER (PARTITION BY b_0) AS _bucket_rate
          FROM agg
        )
      )
      WHERE _bucket_rank <= ${topNLimit}
      ORDER BY _bucket_rate DESC, event_day ASC
    `;
    }

    return `
      WITH ${filteredProfilesCte}${aliasCte}user_events AS (
        SELECT
          ${resolvedPid} AS resolved_pid,
          groupArrayIf(
            toDateTime64(created_at, 3),
            name = '${firstNameLiteral}' AND created_at <= ${endTs}
          ) AS opens,
          groupArrayIf(
            toDateTime64(created_at, 3),
            name = '${lastNameLiteral}'
          ) AS finishes
        FROM ${E}${aliasJoin}
        WHERE project_id = '${projectLiteral}'
          AND name IN ('${firstNameLiteral}', '${lastNameLiteral}')
          AND created_at >= ${startTs}
          AND created_at <= ${extendedEndTs}
          AND ${E}.profile_id != ''${filteredProfilesJoin}
        GROUP BY resolved_pid
        HAVING length(opens) > 0
      ),
      per_user_per_bucket AS (
        SELECT
          resolved_pid,
          arrayJoin(arrayDistinct(arrayMap(o -> ${bucketExpr}, opens))) AS open_bucket,
          arrayMin(arrayFilter(o -> ${bucketExpr} = open_bucket, opens)) AS first_open,
          finishes
        FROM user_events
      )
      SELECT
        open_bucket AS event_day,
        count() AS total_first,
        countIf(arrayExists(
          f -> f >= first_open AND f <= first_open + INTERVAL ${funnelWindowSeconds} SECOND,
          finishes
        )) AS conversions,
        round(
          100.0 * countIf(arrayExists(
            f -> f >= first_open AND f <= first_open + INTERVAL ${funnelWindowSeconds} SECOND,
            finishes
          )) / count(),
          2
        ) AS conversion_rate_percentage
      FROM per_user_per_bucket
      GROUP BY event_day
      ORDER BY event_day ASC
      WITH FILL FROM ${fillStart} TO ${fillEnd} STEP ${fillStep}
    `;
  }

  async getConversion({
    projectId,
    startDate,
    endDate,
    funnelGroup,
    funnelWindow = 24,
    series,
    breakdowns = [],
    holdProperties = [],
    globalFilters = [],
    measuring = 'conversion_rate',
    limit,
    interval,
    timezone,
  }: Omit<IChartInput, 'range' | 'previous' | 'metric' | 'chartType'> & {
    timezone: string;
  }) {
    // Merge global filters into each event's filters (same as fetch.ts does for regular charts)
    const events = onlyReportEvents(series).map(event => ({
      ...event,
      filters: [...(event.filters ?? []), ...globalFilters],
    }));

    if (events.length < 2) {
      throw new Error('events must be at least 2 events');
    }

    if (!startDate || !endDate) {
      throw new Error('startDate and endDate are required');
    }

    // Extract cohort IDs from breakdowns and event filters (deduplicated)
    const cohortIdsSet = new Set<string>();
    breakdowns?.forEach((b) => {
      if (b.cohortId) {
        cohortIdsSet.add(b.cohortId);
      } else if (b.name.startsWith('cohort:')) {
        cohortIdsSet.add(b.name.split(':')[1]!);
      }
    });
    events.forEach((event) => {
      event.filters?.forEach((filter) => {
        if (filter.cohortId) {
          cohortIdsSet.add(filter.cohortId);
        }
      });
    });

    const cohortIds = Array.from(cohortIdsSet);

    // Fetch cohort metadata from Postgres (always fresh, no cache)
    const cohortMetadata = await fetchCohortsMetadata(cohortIds);

    const funnelWindowSeconds = funnelWindow * 3600;

    // Use first and last events for conversion tracking
    const firstEvent = events[0]!;
    const lastEvent = events[events.length - 1]!;

    // Calculate extended end date for conversion events (add funnel window)
    const endDateObj = new Date(endDate);
    const extendedEndDateObj = new Date(endDateObj.getTime() + funnelWindowSeconds * 1000);
    const extendedEndDate = formatClickhouseDate(extendedEndDateObj);

    // Ensure materialized columns cache is warm so getSelectPropertyKey works synchronously
    await getMaterializedColumns('events');

    // Array-aggregate fast path. 3-7x speedup vs the multi-CTE ASOF JOIN path
    // below. Single-scan for no breakdown; split-scan for ONE simple event-level
    // property breakdown. Everything else (holds, cohorts, custom events, session
    // group, TTC, profile.*/cohort breakdowns, multi-breakdown) falls through
    // unchanged to the ASOF path.
    const hasIncompatibleFilters = (event: IChartEvent) =>
      (event.filters ?? []).some(
        (f) =>
          f.name.startsWith('profile.') ||
          f.operator === 'inCohort' ||
          f.operator === 'notInCohort',
      );

    // The array fast path now also supports ONE simple event-level property
    // breakdown (split-scan variant). profile.* / cohort / cohort: breakdowns
    // and multi-breakdown still fall through to the ASOF path unchanged.
    const singleBreakdown = breakdowns.length === 1 ? breakdowns[0] : undefined;
    const isSimpleEventBreakdown = (b?: {
      name: string;
      cohortId?: string;
    }): boolean =>
      !!b &&
      !b.cohortId &&
      !b.name.startsWith('profile.') &&
      !b.name.startsWith('cohort:');

    const canUseArrayPath =
      events.length === 2 &&
      funnelGroup !== 'session_id' &&
      cohortIds.length === 0 &&
      (breakdowns.length === 0 ||
        (breakdowns.length === 1 && isSimpleEventBreakdown(singleBreakdown))) &&
      holdProperties.length === 0 &&
      measuring === 'conversion_rate' &&
      !hasIncompatibleFilters(firstEvent) &&
      !hasIncompatibleFilters(lastEvent);

    if (canUseArrayPath) {
      const [startCustom, endCustom] = await Promise.all([
        getCustomEventByName(firstEvent.name, projectId),
        getCustomEventByName(lastEvent.name, projectId),
      ]);

      if (!startCustom && !endCustom) {
        const arraySql = this.buildArrayPatternSql({
          projectId,
          firstEvent,
          lastEvent,
          startDate,
          endDate,
          extendedEndDate,
          funnelWindowSeconds,
          interval,
          breakdown: singleBreakdown,
          limit,
        });

        const rawResult = await this.client.query({
          query: arraySql,
          clickhouse_settings: { session_timezone: timezone },
        });
        const json = (await rawResult.json()) as {
          data: {
            event_day: string;
            total_first: number;
            conversions: number;
            conversion_rate_percentage: number;
            [key: string]: string | number;
          }[];
        };

        const results = json.data;
        const resultSeries = this.toSeries(results, breakdowns);

        return resultSeries.map((serie, serieIndex) => ({
          ...serie,
          data: serie.data.map((d, index) => ({
            ...d,
            timestamp: new Date(d.date).getTime(),
            serieIndex,
            index,
            serie: omit(['data'], serie),
          })),
        }));
      }
    }
    // ── End array-pattern fast path ───────────────────────────────────

    // Determine which event-property columns are needed from start_events
    // (profile.* and cohort breakdowns are handled separately via JOINs)
    const breakdownExtraCols = breakdowns
      .filter(b => !b.name.startsWith('profile.') && !b.cohortId && !b.name.startsWith('cohort:'))
      .flatMap(b => {
        const col = getSelectPropertyKey(b.name, projectId, undefined);
        if (col.startsWith('profile.') || col.startsWith('if(')) return [];
        // Map access (not materialized) — need the whole properties map
        if (col.startsWith('properties[')) return ['properties'];
        return [col];
      });

    // Hold property constant: columns needed in both CTEs for the JOIN condition
    const holdExtraCols = holdProperties.flatMap(prop => {
      const col = getSelectPropertyKey(prop, projectId, undefined);
      if (col.startsWith('properties[')) return ['properties'];
      return [col];
    });

    const startExtraCols = [...new Set([...breakdownExtraCols, ...holdExtraCols])];
    const endExtraCols = [...new Set(holdExtraCols)];

    // Define group column (profile_id or session_id) — needed by CTE builders below
    const groupCol = funnelGroup === 'session_id' ? 'session_id' : 'profile_id';

    // Build CTEs for start and end events
    const ctes: string[] = [];

    // Identity-merge: resolve anon profile_id -> canonical via profile_aliases so
    // an anon-start / identified-end funnel stitches into one user. This is a no-op
    // for projects with no aliases (coalesce keeps the raw id), so it needs no
    // project gating. Profile-level only (session-level already stitches within a
    // session); skipped for custom events (can't resolve — would mix raw/resolved)
    // and cohorts (cohort joins match raw profile_id). `al` is pushed first so the
    // event CTEs can join it.
    let resolveAliases = false;
    if (groupCol === 'profile_id' && cohortIds.length === 0) {
      const [startCustom, endCustom] = await Promise.all([
        getCustomEventByName(firstEvent.name, projectId),
        getCustomEventByName(lastEvent.name, projectId),
      ]);
      resolveAliases = !startCustom && !endCustom;
    }
    // Only emit the `al` CTE when the dict is OFF; when on, buildSingleEventCte
    // resolves via dictGet and no CTE/JOIN is needed.
    if (resolveAliases && aliasResolutionNeedsCte()) {
      ctes.push(`al AS (
      SELECT alias, argMax(profile_id, created_at) AS canonical
      FROM ${TABLE_NAMES.alias}
      WHERE project_id = '${projectId}'
      GROUP BY alias
    )`);
    }

    // Start events CTE — named _raw so we can wrap it with deduplication below
    const startEventCte = await this.buildSingleEventCte(
      firstEvent,
      'start_events_raw',
      projectId,
      startDate,
      endDate,
      startExtraCols,
      groupCol,
      undefined,
      resolveAliases,
    );
    ctes.push(startEventCte);

    // Deduplicate to one row per (groupCol, day) using the earliest created_at.
    // A user who triggers the start event 50 times a day produces 50 rows — all
    // collapse to the same bucket anyway. Deduplicating here shrinks the left
    // side of the JOIN proportionally, which matters a lot for 30d ranges.
    // Alias is first_open_at (not created_at) to avoid ILLEGAL_AGGREGATION when
    // ClickHouse inlines the CTE and sees the aggregate alias in JOIN/WHERE conditions.
    const otherIdCol = groupCol === 'profile_id' ? 'session_id' : 'profile_id';
    const safeGroupByCols = startExtraCols.filter(c => c !== 'properties');
    const anyWrapCols = startExtraCols.filter(c => c === 'properties');
    // GROUP BY uses _day (pre-computed in the subquery) instead of toDate(created_at)
    // to avoid ClickHouse resolving 'created_at' in toDate(created_at) to the SELECT
    // alias min(created_at) AS first_open_at — which would put an aggregate in GROUP BY.
    const dedupeGroupBy = [quoteCol(groupCol), '_day', ...safeGroupByCols.map(quoteCol)].join(', ');
    const dedupeSelect = [
      quoteCol(groupCol),
      `any(${quoteCol(otherIdCol)}) AS ${quoteCol(otherIdCol)}`,
      'min(created_at) AS first_open_at',
      ...safeGroupByCols.map(quoteCol),
      ...anyWrapCols.map(c => `any(${quoteCol(c)}) AS ${quoteCol(c)}`),
    ].join(', ');
    ctes.push(`start_events AS (
      SELECT ${dedupeSelect}
      FROM (SELECT *, toDate(created_at) AS _day FROM start_events_raw)
      GROUP BY ${dedupeGroupBy}
    )`);

    // End events raw CTE — all matching activation events (custom or regular)
    const endEventCte = await this.buildSingleEventCte(
      lastEvent,
      'end_events_raw',
      projectId,
      startDate,
      extendedEndDate,
      endExtraCols,
      groupCol,
      'start_events_raw',
      resolveAliases,
    );
    ctes.push(endEventCte);

    // Deduplicate end events to one row per (groupCol, hold cols, day).
    // Per-day dedup (not global) so the same user converting on different days
    // is counted as multiple conversions — one per (profile, show, day).
    // Alias is first_act_at (not created_at) for the same ILLEGAL_AGGREGATION reason.
    const endSafeGroupByCols = endExtraCols.filter(c => c !== 'properties');
    const endAnyWrapCols = endExtraCols.filter(c => c === 'properties');
    const endDedupeGroupBy = [quoteCol(groupCol), 'toDate(created_at)', ...endSafeGroupByCols.map(quoteCol)].join(', ');
    const endDedupeSelect = [
      quoteCol(groupCol),
      'min(created_at) AS first_act_at',
      ...endSafeGroupByCols.map(quoteCol),
      ...endAnyWrapCols.map(c => `any(${quoteCol(c)}) AS ${quoteCol(c)}`),
    ].join(', ');
    ctes.push(`end_events AS (
      SELECT ${endDedupeSelect}
      FROM end_events_raw
      GROUP BY ${endDedupeGroupBy}
    )`);

    // Add cohort CTEs, prefiltered to the profiles present in start_events_raw.
    //
    // The base cohort query reads cohort_members FINAL (a ReplacingMergeTree
    // merge at query time) and returns every profile in the cohort — millions
    // of rows for large cohorts. The conversion only ever joins the cohort
    // against se.profile_id, so any profile not in start_events_raw is dead
    // weight in the JOIN hash table.
    //
    // Wrapping with `WHERE profile_id IN (SELECT profile_id FROM start_events_raw)`:
    //   1. Shrinks the LEFT ANY JOIN hash to |cohort ∩ start_events_raw|.
    //   2. Lets ClickHouse's analyzer push the IN into the cohort_members scan,
    //      where the bloom_filter index on profile_id can skip granules that
    //      don't contain any relevant profile — most of the table for narrow
    //      date ranges against large cohorts.
    cohortIds.forEach((cohortId) => {
      const cohortMeta = cohortMetadata.get(cohortId);
      const cohortQuery = buildCohortMembershipQuery(
        cohortId,
        projectId,
        cohortMeta,
        'SELECT profile_id FROM start_events_raw',
      );
      ctes.push(`${getCohortCteName(cohortId)} AS (${cohortQuery})`);
    });

    // Build breakdown columns (from start_events with 'se' alias)
    const breakdownColumns = breakdowns.map((b, index) => {
      const columnWithAlias = this.getBreakdownColumnWithAlias(b.name, projectId, b.cohortId, 'se', b.cohortId ? cohortMetadata.get(b.cohortId)?.name : undefined);
      return `${columnWithAlias} as b_${index}`;
    });
    const breakdownGroupBy = breakdowns.map((b, index) => `b_${index}`);

    // Build LEFT JOINs for cohorts (on start_events)
    const cohortJoins = cohortIds.length > 0 ? '\n      ' + cohortIds.map((cohortId) => {
      const cohortAlias = getCohortAlias(cohortId);
      const cohortCte = getCohortCteName(cohortId);
      return `LEFT ANY JOIN ${cohortCte} AS ${cohortAlias} ON ${cohortAlias}.profile_id = se.profile_id`;
    }).join('\n      ') : '';

    // Build LEFT JOIN for profile table if any breakdown uses profile.*.
    // For profile.properties.X paths, extract the specific key as an aliased
    // column rather than pulling the whole `properties` Map — avoids name
    // collision with events.properties when breakdowns mix profile.* and
    // event-level properties.* paths. Matches the alias form returned by
    // getSelectPropertyKey for profile.properties.X.
    const profileBreakdowns = breakdowns.filter(b => b.name.startsWith('profile.'));
    let profileJoin = '';
    if (profileBreakdowns.length > 0) {
      const matCols = await getMaterializedColumns('profiles');
      const profileColumns = [...new Set(
        profileBreakdowns.flatMap(b => {
          if (b.name.startsWith('profile.properties.')) {
            const cached = matCols[b.name];
            if (cached) {
              return [cached.replace('profile.', '')];
            }
            const key = b.name.replace('profile.properties.', '');
            return [`properties[${sqlstring.escape(key)}] AS \`properties.${key}\``];
          }
          return [b.name.replace('profile.', '').split('.')[0]!];
        })
      )];
      profileJoin = `\n      LEFT JOIN (SELECT id, ${profileColumns.join(', ')} FROM ${TABLE_NAMES.profiles} FINAL WHERE project_id = '${projectId}') AS profile ON profile.id = se.profile_id`;
    }

    // Grace period for events that fire very close together (like Mixpanel)
    // Allows end event to happen up to 2 seconds before start event
    const gracePeriodSeconds = 2;

    // Hold property constant: require same property value in start and end events
    const holdJoinConditions = holdProperties.map(prop => {
      const col = getSelectPropertyKey(prop, projectId, undefined);
      return `AND se.${col} = ee.${col}`;
    }).join('\n        ');

    const toStartOf = clix.toStartOf('se.first_open_at', interval);
    const breakdownGroupByStr = breakdownGroupBy.join(', ');

    // ASOF LEFT JOIN matches each start event with the closest end event whose
    // first_act_at is at or after (start - grace). The inequality is the asof
    // condition; everything else (groupCol, hold properties) is plain equality.
    // ClickHouse picks exactly one matched (or unmatched-default) row per start,
    // so the equi-join + range filter + inner GROUP BY pattern collapses into a
    // single pass with no fanout when a (user, hold-tuple, day) bucket has many
    // candidate end events.
    const asofLowerBound = `AND ee.first_act_at >= se.first_open_at - INTERVAL ${gracePeriodSeconds} SECOND`;

    // Per-row conversion check. ASOF returns the smallest matching ee.first_act_at,
    // so the upper bound is checked here (not in the join): if the closest match
    // lies past the funnel window, treat it as not converted. notEmpty() handles
    // both join_use_nulls modes — '' under default 0, NULL under 1 — matching the
    // pattern used by the cohort filters below and in chart.service.ts.
    const conversionCondition = `notEmpty(ee.${groupCol}) AND ee.first_act_at <= se.first_open_at + INTERVAL ${funnelWindowSeconds} SECOND`;

    // Time-to-convert: ASOF emits a single matched row per start, so no minIf is
    // needed — dateDiff is already correct per row. Emit NULL when unmatched (or
    // matched but past the window) so quantile / avg / min / max skip it.
    const timeDiffCol = measuring === 'time_to_convert'
      ? `,\n        if(${conversionCondition}, dateDiff('second', se.first_open_at, ee.first_act_at), NULL) AS time_diff_seconds`
      : '';

    // Build WHERE clause for cohort global filters (inCohort / notInCohort).
    // Applied per joined row, before the agg CTE aggregates by event_day.
    const cohortFilterClauses = events.flatMap(event =>
      (event.filters ?? [])
        .filter(f => (f.operator === 'inCohort' || f.operator === 'notInCohort') && f.cohortId)
        .map(f => {
          const alias = getCohortAlias(f.cohortId!);
          return f.operator === 'inCohort'
            ? `notEmpty(${alias}.profile_id)`
            : `empty(${alias}.profile_id)`;
        })
    );
    // Deduplicate (same filter merged into multiple events)
    const uniqueCohortFilterClauses = [...new Set(cohortFilterClauses)];
    const cohortFilterWhere = uniqueCohortFilterClauses.length > 0
      ? `\n      WHERE ${uniqueCohortFilterClauses.join('\n        AND ')}`
      : '';

    // One row per start_events row — ASOF guarantees a single matched-or-default
    // ee row, so no inner GROUP BY is needed. The agg CTE below aggregates
    // (event_day, breakdown) into total_first / conversions.
    const innerSQL = `
      SELECT
        ${toStartOf} AS event_day,
        se.${groupCol},
        ${conversionCondition} AS converted${breakdownColumns.length ? ',\n        ' + breakdownColumns.join(',\n        ') : ''}${timeDiffCol}
      FROM start_events se${profileJoin}
      ASOF LEFT JOIN end_events ee ON
        ee.${groupCol} = se.${groupCol}
        ${holdJoinConditions}
        ${asofLowerBound}
      ${cohortJoins}${cohortFilterWhere}`;

    // TTC aggregation columns — condition is 'converted' (Bool) so TTC stats
    // are computed only over start events that actually had a conversion.
    const ttcAggColumns = measuring === 'time_to_convert'
      ? `,
        round(avgIf(time_diff_seconds, converted)) AS ttc_avg,
        round(quantileIf(0.5)(time_diff_seconds, converted)) AS ttc_median,
        minIf(time_diff_seconds, converted) AS ttc_min,
        maxIf(time_diff_seconds, converted) AS ttc_max,
        round(quantileIf(0.25)(time_diff_seconds, converted)) AS ttc_p25,
        round(quantileIf(0.75)(time_diff_seconds, converted)) AS ttc_p75,
        round(quantileIf(0.9)(time_diff_seconds, converted)) AS ttc_p90,
        round(quantileIf(0.99)(time_diff_seconds, converted)) AS ttc_p99`
      : '';

    // agg CTE: count() for total opens, countIf(converted) for conversions.
    // Counts all conversion opportunities (not just unique users) so the same
    // user opening the same show on different days contributes multiple times.
    const aggCte = `agg AS (
      SELECT
        event_day,
        ${breakdownGroupBy.length ? breakdownGroupByStr + ',\n        ' : ''}count() AS total_first,
        countIf(converted) AS conversions,
        round(100.0 * countIf(converted) / count(), 2) AS conversion_rate_percentage${ttcAggColumns}
      FROM (${innerSQL})
      GROUP BY event_day${breakdownGroupBy.length ? ', ' + breakdownGroupByStr : ''}
    )`;

    // TTC columns for final SELECT
    const ttcSelectColumns = measuring === 'time_to_convert'
      ? ', ttc_avg, ttc_median, ttc_min, ttc_max, ttc_p25, ttc_p75, ttc_p90, ttc_p99'
      : '';
    const ttcSelectColumnsWithPrefix = measuring === 'time_to_convert'
      ? ',\n          agg.ttc_avg, agg.ttc_median, agg.ttc_min, agg.ttc_max, agg.ttc_p25, agg.ttc_p75, agg.ttc_p90, agg.ttc_p99'
      : '';

    let finalSql: string;

    if (breakdownGroupBy.length > 0) {
      // Rank breakdowns inline via a window function instead of a separate
      // top_breakdowns CTE that JOINs back to agg. The old pattern referenced
      // `agg` twice (once in top_breakdowns, once in the outer SELECT), which
      // CH inlined — making the full conversion subtree run twice per query.
      // Window function over a single `FROM agg` halves CH work.
      const rankMetric = measuring === 'time_to_convert'
        ? 'avg(ttc_avg)'
        : 'avg(conversion_rate_percentage)';
      const rankDirection = measuring === 'time_to_convert' ? 'ASC' : 'DESC';
      const topNLimit = limit ?? 50;
      const partitionBy = breakdownGroupByStr;

      finalSql = `
        WITH ${[...ctes, aggCte].join(',\n')}
        SELECT
          event_day,
          ${breakdownGroupBy.join(',\n          ')},
          total_first,
          conversions,
          conversion_rate_percentage${ttcSelectColumns}
        FROM (
          SELECT *,
            dense_rank() OVER (ORDER BY _bucket_rate ${rankDirection}) AS _bucket_rank
          FROM (
            SELECT *,
              ${rankMetric} OVER (PARTITION BY ${partitionBy}) AS _bucket_rate
            FROM agg
          )
        )
        WHERE _bucket_rank <= ${topNLimit}
        ORDER BY _bucket_rate ${rankDirection}, event_day ASC`;
    } else {
      finalSql = `
        WITH ${[...ctes, aggCte].join(',\n')}
        SELECT event_day, total_first, conversions, conversion_rate_percentage${ttcSelectColumns}
        FROM agg
        ORDER BY event_day ASC`;
    }

    const rawResult = await this.client.query({
      query: finalSql,
      clickhouse_settings: { session_timezone: timezone },
    });
    const json = await rawResult.json() as {
      data: {
        event_day: string;
        total_first: number;
        conversions: number;
        conversion_rate_percentage: number;
        [key: string]: string | number;
      }[];
    };
    const results = json.data;

    const resultSeries = this.toSeries(results, breakdowns);
    const limitedSeries = resultSeries;

    return limitedSeries.map((serie, serieIndex) => {
      return {
        ...serie,
        data: serie.data.map((d, index) => ({
          ...d,
          timestamp: new Date(d.date).getTime(),
          serieIndex,
          index,
          serie: omit(['data'], serie),
        })),
      };
    });
  }

  private mapDataPoint(d: { [key: string]: string | number }) {
    const base = {
      date: d.event_day as string,
      total: Number(d.total_first),
      conversions: Number(d.conversions),
      rate: Number(d.conversion_rate_percentage),
    };
    // Include TTC aggregations when present
    if (d.ttc_avg != null) {
      return {
        ...base,
        ttc: {
          avg: Number(d.ttc_avg),
          median: Number(d.ttc_median),
          min: Number(d.ttc_min),
          max: Number(d.ttc_max),
          p25: Number(d.ttc_p25),
          p75: Number(d.ttc_p75),
          p90: Number(d.ttc_p90),
          p99: Number(d.ttc_p99),
        },
      };
    }
    return base;
  }

  private toSeries(
    data: {
      event_day: string;
      total_first: number;
      conversions: number;
      conversion_rate_percentage: number;
      [key: string]: string | number;
    }[],
    breakdowns: { name: string }[] = [],
  ) {
    if (!breakdowns.length) {
      return [
        {
          id: 'conversion',
          breakdowns: [],
          data: data.map((d) => this.mapDataPoint(d)),
        },
      ];
    }

    // Group by breakdown values
    const series = data.reduce(
      (acc, d) => {
        const key =
          breakdowns.map((b, index) => d[`b_${index}`]).join('|') ||
          NOT_SET_VALUE;
        if (!acc[key]) {
          acc[key] = {
            id: key,
            breakdowns: breakdowns.map(
              (b, index) => (d[`b_${index}`] || NOT_SET_VALUE) as string,
            ),
            data: [],
          };
        }
        acc[key]!.data.push(this.mapDataPoint(d));
        return acc;
      },
      {} as Record<
        string,
        {
          id: string;
          breakdowns: string[];
          data: any[];
        }
      >,
    );

    return Object.values(series).map((serie, serieIndex) => ({
      ...serie,
      data: serie.data.map((item, dataIndex) => ({
        ...item,
        dataIndex,
        serieIndex,
      })),
    }));
  }
}

export const conversionService = new ConversionService(ch);
