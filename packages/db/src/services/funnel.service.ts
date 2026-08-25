import { ifNaN } from '@openpanel/common';
import type {
  IChartEvent,
  IChartEventItem,
  IChartInput,
} from '@openpanel/validation';
import { last, reverse, uniq } from 'ramda';
import sqlstring from 'sqlstring';
import { ch, formatClickhouseDate } from '../clickhouse/client';
import {
  TABLE_NAMES,
  getEventsTableForRange,
  resolvedPersonIdSql,
  aliasResolutionNeedsCte,
} from '../clickhouse/client';
import { clix } from '../clickhouse/query-builder';
import { createSqlBuilder } from '../sql-builder';
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
import {
  getCustomEventByName,
  expandCustomEventToSQL,
} from './custom-event.service';

export class FunnelService {
  constructor(private client: typeof ch) {}

  /**
   * Build events source for funnel query
   * Handles both regular events and custom events
   */
  async buildEventsSource(
    events: IChartEvent[],
    projectId: string,
    startDate: string,
    endDate: string,
    selectColumns?: string[],
  ): Promise<{
    fromClause: string;
    withClauses: Array<{ name: string; query: any }>;
    needsNameFilter: boolean;
  }> {
    // Check which events are custom events
    const customEventsChecks = await Promise.all(
      events.map((event) => getCustomEventByName(event.name, projectId)),
    );

    const hasCustomEvents = customEventsChecks.some((ce) => ce !== null);

    // If no custom events, use regular events table (routed to events_v2 when the
    // range is inside its complete window).
    if (!hasCustomEvents) {
      return {
        fromClause: getEventsTableForRange(startDate),
        withClauses: [],
        needsNameFilter: true,
      };
    }

    const withClauses: Array<{ name: string; query: any }> = [];
    const baseWhere = [
      `created_at >= toDateTime('${formatClickhouseDate(startDate)}')`,
      `created_at <= toDateTime('${formatClickhouseDate(endDate)}')`,
    ];
    const unionParts: string[] = [];

    // Deduped, backtick-quoted projection list for the union wrapper.
    // Stripping any pre-existing backticks before re-quoting keeps the
    // SELECT list consistent regardless of how upstream produced the names.
    const dedupedSelectColumns =
      selectColumns && selectColumns.length > 0
        ? [...new Set(selectColumns)].map(
            (c) => `\`${c.replace(/^`|`$/g, '')}\``,
          )
        : null;

    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      const customEvent = customEventsChecks[i];
      const cteName = `event_${i}`;

      // Use expandCustomEventToSQL for all events — custom and regular alike.
      // Materialized column handling is centralised there; regular events get
      // a synthetic single-event definition that produces identical SQL to the
      // direct table query, without duplicating column-quoting logic here.
      const sql = await expandCustomEventToSQL(
        {
          name: event.name,
          projectId,
          definition: customEvent?.definition ?? { events: [{ name: event.name }] },
        } as any,
        baseWhere,
        selectColumns,
        startDate,
      );

      withClauses.push({ name: cteName, query: sql });
      if (dedupedSelectColumns) {
        // Minimal projection path: the inner CTE returns only the columns we
        // need (no SELECT *), and we attach the custom-event display name
        // here. CAST to plain String keeps all UNION ALL branches the same
        // type — without it, branches mix String Const and LowCardinality
        // and the union errors with a Block structure mismatch.
        unionParts.push(
          `SELECT ${dedupedSelectColumns.join(', ')}, CAST(${sqlstring.escape(event.name)} AS String) AS name FROM ${cteName}`,
        );
      } else {
        // Legacy path: SELECT * REPLACE keeps the renamed name column and
        // every other column from events. Heavy — only taken when no
        // selectColumns are provided.
        unionParts.push(
          `SELECT * REPLACE(CAST(name AS String) AS name) FROM ${cteName}`,
        );
      }
    }

    // Create combined_events CTE
    withClauses.push({
      name: 'combined_events',
      query: unionParts.join(' UNION ALL '),
    });

    return {
      fromClause: 'combined_events',
      withClauses,
      needsNameFilter: false, // Already filtered in CTEs
    };
  }

  /**
   * Collect the column names the funnel actually needs from the events
   * table source — driven by filters (incl. globalFilters which the caller
   * has already merged into each event's filters), breakdowns, and hold
   * properties. Materialized columns are referenced by name; unmaterialized
   * map keys cause us to pull the whole `properties` Map.
   *
   * Mirrors the equivalent collection in conversion.service.ts so the funnel
   * CTE projection stays minimal and ClickHouse can skip reading unrelated
   * columns (especially the heavy `properties` Map when everything we need
   * has been materialized).
   */
  private getEventsSourceSelectColumns({
    eventSeries,
    breakdowns,
    holdProperties,
    projectId,
  }: {
    eventSeries: IChartEvent[];
    breakdowns: { name: string; cohortId?: string }[];
    holdProperties: string[];
    projectId: string;
  }): string[] {
    const stripBackticks = (s: string) => s.replace(/^`|`$/g, '');

    // Drop the "properties[...]" map-access form, the "if(...)" cohort
    // form, and any profile.* paths — none of those resolve to a base
    // column we can put in the SELECT list.
    const exprToColumn = (expr: string): string[] => {
      if (expr.startsWith('properties[')) return ['properties'];
      if (expr.startsWith('if(') || expr.startsWith('profile.')) return [];
      return [stripBackticks(expr)];
    };

    const filterCols = eventSeries.flatMap((event) =>
      (event.filters ?? []).flatMap((f) => {
        // Cohort filters resolve via JOIN on a separate CTE, not via a
        // column on `events`.
        if (f.operator === 'inCohort' || f.operator === 'notInCohort')
          return [];
        // profile.* filters resolve via the profile LEFT JOIN.
        if (f.name.startsWith('profile.')) return [];
        return exprToColumn(
          getSelectPropertyKey(f.name, projectId, f.cohortId, undefined),
        );
      }),
    );

    const breakdownCols = breakdowns.flatMap((b) => {
      if (b.cohortId || b.name.startsWith('cohort:') || b.name.startsWith('profile.'))
        return [];
      return exprToColumn(
        getSelectPropertyKey(b.name, projectId, undefined),
      );
    });

    const holdCols = holdProperties.flatMap((prop) =>
      exprToColumn(getSelectPropertyKey(prop, projectId, undefined)),
    );

    return [
      // project_id is filtered by the outer funnel CTE via
      // `WHERE project_id = ...`; include it here so the column exists on
      // `combined_events`. The per-event CTEs are already filtered by
      // project_id, so this outer filter is logically redundant but it's
      // emitted unconditionally by the SQL builder.
      'project_id',
      'profile_id',
      'session_id',
      'created_at',
      ...filterCols,
      ...breakdownCols,
      ...holdCols,
    ];
  }

  getFunnelConditions(events: IChartEvent[] = [], projectId?: string): string[] {
    return events.map((event) => {
      const { sb, getWhere } = createSqlBuilder();
      sb.where = getEventFiltersWhereClause(event.filters, projectId);
      sb.where.name = `name = ${sqlstring.escape(event.name)}`;
      return getWhere().replace('WHERE ', '');
    });
  }

  resolveFunnelGroup(
    funnelGroup: string | undefined | null,
    fromClause: string,
    resolveAliases = false,
    projectId?: string,
  ): [string, string] {
    if (funnelGroup === 'session_id') {
      return [`${fromClause}.session_id`, 'session_id'];
    }
    // Base: the event's own profile_id.
    //
    // Previously this was session-stitched: `COALESCE(nullIf(s.pid,''), profile_id)`
    // (upstream), on the theory that a session already carries the identified id.
    // But `session_id` is NOT a reliable per-user key on every project — notably on
    // the Kafka-path projects (frameo/shortreels) hit by the session-dup incident,
    // where many *different* users' events share a session_id. There, `s.pid`
    // collapses distinct users onto a handful of shared session pids (observed: a
    // funnel with 14 real completers listed only 4 in "View Users").
    //
    // Identity-merge via profile_aliases/dictGet (layered below) already bridges a
    // user's anon -> identified events correctly, making the session stitch
    // redundant, so we drop it. resolveAliases=false (dict off / no aliases) now
    // keys on the raw profile_id.
    const base = `${fromClause}.profile_id`;
    // Look up the RAW event device_id in the alias map (the alias is keyed on
    // $device_id, NOT the anon distinct_id that lands in profile_id — see the
    // mixpanel-proxy split), falling back to profile_id. Same key the `al` CTE
    // joins on. Both dict + CTE modes group identically.
    const expr = resolveAliases
      ? resolvedPersonIdSql(projectId ?? '', `${fromClause}.device_id`, base)
      : base;
    return [expr, 'profile_id'];
  }

  buildFunnelCte({
    projectId,
    startDate,
    endDate,
    eventSeries,
    funnelWindowMilliseconds,
    group,
    timezone,
    additionalSelects = [],
    additionalGroupBy = [],
    fromClause,
    needsNameFilter,
    funnelConditions,
  }: {
    projectId: string;
    startDate: string;
    endDate: string;
    eventSeries: IChartEvent[];
    funnelWindowMilliseconds: number;
    group: [string, string];
    timezone: string;
    additionalSelects?: string[];
    additionalGroupBy?: string[];
    fromClause: string;
    needsNameFilter: boolean;
    // When the caller (getFunnel) hoists event filters to a
    // `filtered_profiles` pre-CTE, it passes name-only conditions here so
    // windowFunnel doesn't re-read the filtered columns (country, etc.) —
    // those reads would break proj_funnel routing. Default is the existing
    // behaviour: per-step name + event-filter conditions.
    funnelConditions?: string[];
  }) {
    const funnels =
      funnelConditions ?? this.getFunnelConditions(eventSeries, projectId);

    const query = clix(this.client, timezone)
      .select([
        `${group[0]} AS ${group[1]}`,
        ...additionalSelects,
        `windowFunnel(${funnelWindowMilliseconds}, 'strict_increase')(toUInt64(toUnixTimestamp64Milli(created_at)), ${funnels.join(', ')}) AS level`,
      ])
      .from(fromClause, false)
      .where('project_id', '=', projectId)
      .groupBy([group[1], ...additionalGroupBy]);

    // Add date and name filters only for regular events
    if (needsNameFilter) {
      query
        .where('created_at', 'BETWEEN', [
          clix.datetime(startDate, 'toDateTime'),
          clix.datetime(endDate, 'toDateTime'),
        ])
        .where(
          'name',
          'IN',
          eventSeries.map((e) => e.name),
        );
    }

    return query;
  }

  private fillFunnel(
    funnel: { level: number; count: number }[],
    steps: number,
  ) {
    const filled = Array.from({ length: steps }, (_, index) => {
      const level = index + 1;
      const matchingResult = funnel.find((res) => res.level === level);
      return {
        level,
        count: matchingResult ? matchingResult.count : 0,
      };
    });

    // Accumulate counts from top to bottom of the funnel
    for (let i = filled.length - 1; i >= 0; i--) {
      const step = filled[i];
      const prevStep = filled[i + 1];
      // If there's a previous step, add the count to the current step
      if (step && prevStep) {
        step.count += prevStep.count;
      }
    }
    return filled.reverse();
  }

  toSeries(
    funnel: { level: number; count: number; [key: string]: any }[],
    breakdowns: { name: string }[] = [],
    limit: number | undefined = undefined,
  ) {
    if (!breakdowns.length) {
      return [
        funnel.map((f) => ({
          level: f.level,
          count: f.count,
          id: 'none',
          breakdowns: [],
        })),
      ];
    }

    // Group by breakdown values
    const series = funnel.reduce(
      (acc, f) => {
        if (limit && Object.keys(acc).length >= limit) {
          return acc;
        }

        const key = breakdowns.map((b, index) => f[`b_${index}`]).join('|');
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key]!.push({
          id: key,
          breakdowns: breakdowns.map((b, index) => f[`b_${index}`]),
          level: f.level,
          count: f.count,
        });
        return acc;
      },
      {} as Record<
        string,
        {
          id: string;
          breakdowns: string[];
          level: number;
          count: number;
        }[]
      >,
    );

    return Object.values(series);
  }

  getProfileFilters(events: IChartEvent[]) {
    return events.flatMap((e) =>
      e.filters
        ?.filter((f) => f.name.startsWith('profile.'))
        .map((f) => f.name.replace('profile.', '')),
    );
  }

  async getFunnel({
    projectId,
    startDate,
    endDate,
    series,
    interval,
    funnelWindow = 24,
    funnelGroup,
    breakdowns = [],
    holdProperties = [],
    globalFilters = [],
    measuring = 'conversion_rate',
    limit,
    timezone = 'UTC',
  }: IChartInput & { timezone: string; events?: IChartEvent[] }) {
    if (!startDate || !endDate) {
      throw new Error('startDate and endDate are required');
    }

    // Merge global filters into each event's filters (same as fetch.ts does for regular charts)
    const eventSeries = onlyReportEvents(series).map(event => ({
      ...event,
      filters: [...(event.filters ?? []), ...globalFilters],
    }));

    if (eventSeries.length === 0) {
      throw new Error('events are required');
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
    eventSeries.forEach((event) => {
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
    const funnelWindowMilliseconds = funnelWindowSeconds * 1000;
    const profileFilters = this.getProfileFilters(eventSeries);
    const anyFilterOnProfile = profileFilters.length > 0;
    const anyBreakdownOnProfile = breakdowns.some((b) =>
      b.name.startsWith('profile.'),
    );

    // Compute the minimal column set the funnel actually needs from the
    // events table — driven by filters, breakdowns, and hold properties.
    // Passing this to buildEventsSource switches the per-event CTEs from
    // `SELECT * REPLACE(...)` (every column, incl. the heavy `properties`
    // Map) to a targeted SELECT, mirroring the conversion service's
    // approach. Measured impact on a 1-day Tabahi funnel: ~7x faster, ~8x
    // less data read, no more 40s timeouts for the same query.
    const eventsSourceSelectColumns = this.getEventsSourceSelectColumns({
      eventSeries,
      breakdowns,
      holdProperties,
      projectId,
    });

    // Get events source (handles custom events)
    const { fromClause, withClauses, needsNameFilter } =
      await this.buildEventsSource(
        eventSeries,
        projectId,
        startDate,
        endDate,
        eventsSourceSelectColumns,
      );

    // Identity-merge: resolve anon profile_id -> canonical via profile_aliases so a
    // user's anon + identified events collapse into one funnel subject across
    // sessions. No-op for projects with no aliases (coalesce keeps the raw id), so
    // no gating needed. Profile-level only. Custom events are fine — resolution is
    // applied at the group level after the union, not inside the per-event CTEs.
    //
    // Cohorts: previously this was force-disabled when a cohort was present
    // (cohort joins matched RAW profile_id, so a cross-identity funnel — anon
    // `$ae_first_open` -> identified `trialStarted` inside a cohort — dropped later
    // steps to 0). We now KEEP resolution on with cohorts WHEN THE DICT IS ON: the
    // resolved group is a self-contained dictGet, the cohort membership is resolved
    // to the same canonical (buildCohortMembershipQuery(resolveIdentity)), and the
    // cohort JOIN keys on the resolved group — all three in one identity space.
    // With the dict OFF we keep the old raw behavior to avoid the `al` CTE having
    // to be reordered before the cohort joins.
    const resolveAliases =
      funnelGroup !== 'session_id' &&
      (cohortIds.length === 0 || !aliasResolutionNeedsCte());

    // Hoist event filters to a `filtered_profiles` pre-CTE when conditions
    // allow (mirrors the conversion service's fast path). Filters inside
    // windowFunnel conditions force CH off proj_funnel for column reads on
    // columns not in the projection (most notably country) — measured 3-7x
    // speedup on filtered funnels by pre-filtering at the user level.
    //
    // Hoisting is only safe when filters are identical across every step
    // (the "global filter" case). When step N has a different filter than
    // step M (e.g. screenName='TRAIL_PURCHASE_SCREEN' on step 1 only,
    // country='US' on all steps), the fast path would (a) AND those
    // filters together in filtered_profiles — narrower than per-step
    // requires, and (b) drop them from windowFunnel — letting any event
    // with the right name match the step, inflating conversions. So we
    // gate strictly to uniform-filters and let mixed-filter funnels fall
    // back to the slower-but-correct path.
    const eventFilterSets = eventSeries.map((e) =>
      JSON.stringify(
        (e.filters ?? [])
          .filter(
            (f) =>
              !f.name.startsWith('profile.') &&
              f.operator !== 'inCohort' &&
              f.operator !== 'notInCohort',
          )
          .map((f) => ({
            name: f.name,
            operator: f.operator,
            value: f.value,
          }))
          .sort((a, b) => (a.name + a.operator).localeCompare(b.name + b.operator)),
      ),
    );
    const allFiltersIdentical = eventFilterSets.every(
      (s) => s === eventFilterSets[0],
    );
    const eventFiltersForPrefilter = (eventSeries[0]?.filters ?? []).filter(
      (f) =>
        !f.name.startsWith('profile.') &&
        f.operator !== 'inCohort' &&
        f.operator !== 'notInCohort',
    );
    const canPrefilterUsers =
      allFiltersIdentical &&
      eventFiltersForPrefilter.length > 0 &&
      breakdowns.length === 0 &&
      holdProperties.length === 0 &&
      cohortIds.length === 0 &&
      !anyFilterOnProfile &&
      withClauses.length === 0; // no custom-event CTEs

    // Determine group column using the actual fromClause (not hardcoded table name)
    const group = this.resolveFunnelGroup(
      funnelGroup,
      fromClause,
      resolveAliases,
      projectId,
    );

    const filteredProfilesClauses = canPrefilterUsers
      ? [
          ...new Set(
            Object.values(
              getEventFiltersWhereClause(eventFiltersForPrefilter, projectId),
            ),
          ),
        ]
      : [];

    // When pre-filtering at the user level, drop filters from windowFunnel
    // conditions (just keep `name = 'X'`) — the column reads they triggered
    // were the source of the slowdown. The filtered_profiles WHERE narrows
    // input to matching users; windowFunnel only checks step membership by
    // name.
    const funnelConditions = canPrefilterUsers
      ? eventSeries.map((e) => `name = ${sqlstring.escape(e.name)}`)
      : this.getFunnelConditions(eventSeries, projectId);
    const step1Condition = funnelConditions[0];

    // Pull breakdown value from step 1's qualifying events only via anyIf().
    // Without this, the breakdown column would be added to the windowFunnel
    // GROUP BY, which buckets events by their breakdown value before
    // windowFunnel sees them — so a property that exists on step 1 events
    // (e.g. `thumbnail_container_index` on `showOpen`) but not on later
    // events would push those later events into a different bucket and
    // they'd never match, producing zero conversions.
    // Mirrors the conversion service's "breakdown from start_events" behaviour.
    //
    // Matches an event qualifying for ANY funnel step (name + that step's
    // filters). Used by first/last so the breakdown value can only come from a
    // real funnel-step event, not a filtered-out or unrelated row. Uses the
    // outer-scope `funnelConditions` (line ~559) — when the fast path is
    // active it's name-only, but breakdowns gate the fast path off
    // (`breakdowns.length === 0`), so anyStepCondition is only consulted in
    // the slow-path branch where funnelConditions carries full per-step
    // predicates.
    const anyStepCondition = funnelConditions
      .filter(Boolean)
      .map((c) => `(${c})`)
      .join(' OR ');
    const breakdownSelects = breakdowns.map((b, index) => {
      const expr = getSelectPropertyKey(
        b.name,
        projectId,
        b.cohortId,
        b.cohortId ? cohortMetadata.get(b.cohortId)?.name : undefined,
      );

      // Cohort breakdowns are membership-based — per-step sourcing doesn't apply.
      const isCohort = !!b.cohortId || b.name.startsWith('cohort:');
      if (isCohort) {
        return step1Condition
          ? `anyIf(${expr}, ${step1Condition}) as b_${index}`
          : `${expr} as b_${index}`;
      }

      // 'first'/'last' = value at the first/last qualifying funnel-step event
      // (by time) where the property is defined. Gated on anyStepCondition so a
      // filtered-out or unrelated event can't supply the value.
      if ((b.step === 'first' || b.step === 'last') && anyStepCondition) {
        const cond = `(${anyStepCondition}) AND notEmpty(toString(${expr}))`;
        const fn = b.step === 'first' ? 'argMinIf' : 'argMaxIf';
        return `${fn}(${expr}, created_at, ${cond}) as b_${index}`;
      }

      // Specific step (1-based); default step 1 (current behaviour). Pull the
      // value from that step's qualifying events and apply it to the user.
      const stepIndex = (typeof b.step === 'number' ? b.step : 1) - 1;
      const stepCondition = funnelConditions[stepIndex] ?? step1Condition;
      return stepCondition
        ? `anyIf(${expr}, ${stepCondition}) as b_${index}`
        : `${expr} as b_${index}`;
    });
    const breakdownGroupBy: string[] = [];

    // Hold property constant: add to inner CTE GROUP BY so windowFunnel()
    // evaluates per (profile_id, property_value), but NOT to outer query
    // so results aggregate into a single funnel.
    const holdPropertySelects = holdProperties.map(
      (prop, i) => `${getSelectPropertyKey(prop, projectId)} as hp_${i}`,
    );
    const holdPropertyGroupBy = holdProperties.map((_, i) => `hp_${i}`);

    const funnelCte = this.buildFunnelCte({
      projectId,
      startDate,
      endDate,
      eventSeries,
      funnelWindowMilliseconds,
      group,
      timezone,
      additionalSelects: [...breakdownSelects, ...holdPropertySelects],
      additionalGroupBy: [...breakdownGroupBy, ...holdPropertyGroupBy],
      fromClause,
      needsNameFilter,
      funnelConditions,
    });

    if (anyFilterOnProfile || anyBreakdownOnProfile) {
      const matCols = await getMaterializedColumns('profiles');

      // Collect fields needed from profile table (from both filters and breakdowns)
      const profileFieldsSet = new Set<string>(['id']);

      // From event filters
      for (const f of profileFilters) {
        // f is like "properties.campaign" or "email" (already has "profile." stripped)
        if (f.startsWith('properties.')) {
          const fullKey = `profile.${f}`; // "profile.properties.campaign"
          const cached = matCols[fullKey];
          if (cached) {
            profileFieldsSet.add(cached.replace('profile.', ''));
          } else {
            // Extract specific key as aliased column instead of pulling the
            // whole `properties` Map — avoids name collision with
            // events.properties when a funnel mixes profile.* and
            // event-level properties.* filters. Pairs with the matching
            // alias form in getSelectPropertyKey.
            const key = f.replace('properties.', '');
            profileFieldsSet.add(
              `properties[${sqlstring.escape(key)}] AS \`properties.${key}\``,
            );
          }
        } else {
          profileFieldsSet.add(f.split('.')[0]!);
        }
      }

      // From profile breakdowns
      for (const b of breakdowns.filter((b) => b.name.startsWith('profile.'))) {
        if (b.name.startsWith('profile.properties.')) {
          const cached = matCols[b.name];
          if (cached) {
            profileFieldsSet.add(cached.replace('profile.', ''));
          } else {
            const key = b.name.replace('profile.properties.', '');
            profileFieldsSet.add(
              `properties[${sqlstring.escape(key)}] AS \`properties.${key}\``,
            );
          }
        } else {
          const fieldName = b.name.replace('profile.', '').split('.')[0];
          if (fieldName) {
            profileFieldsSet.add(fieldName);
          }
        }
      }

      funnelCte.leftJoin(
        `(SELECT ${Array.from(profileFieldsSet).join(', ')} FROM ${TABLE_NAMES.profiles} FINAL
          WHERE project_id = ${sqlstring.escape(projectId)}) as profile`,
        `profile.id = ${fromClause}.profile_id`,
      );
    }

    // Add LEFT JOINs for all cohorts (much faster than IN subqueries).
    // Key on the RESOLVED person (group[0]) so it lines up with the cohort
    // membership, which is resolved to the same canonical when resolveAliases is
    // on. When off (session group / dict off), group[0] is the raw profile_id and
    // the membership is raw too — identical to the previous behavior.
    const cohortJoinKey = resolveAliases ? group[0] : `${fromClause}.profile_id`;
    cohortIds.forEach((cohortId) => {
      const cohortAlias = getCohortAlias(cohortId);
      const cohortCte = getCohortCteName(cohortId);
      funnelCte.leftJoin(
        `${cohortCte} AS ${cohortAlias}`,
        `${cohortAlias}.profile_id = ${cohortJoinKey}`,
      );
    });

    // Apply cohort global filter WHERE clauses (inCohort / notInCohort)
    eventSeries.forEach((event) => {
      (event.filters ?? []).forEach((filter) => {
        if (filter.operator === 'inCohort' && filter.cohortId) {
          const alias = getCohortAlias(filter.cohortId);
          funnelCte.where(`${alias}.profile_id`, '!=', '');
        } else if (filter.operator === 'notInCohort' && filter.cohortId) {
          const alias = getCohortAlias(filter.cohortId);
          funnelCte.where(`${alias}.profile_id`, '=', '');
        }
      });
    });

    // Base funnel query with CTEs
    const funnelQuery = clix(this.client, timezone);

    // Add custom event CTEs first (if any)
    for (const withClause of withClauses) {
      funnelQuery.with(withClause.name, withClause.query);
    }

    // Add cohort CTEs (computed once per query, not per row). Resolve membership
    // to canonical when the funnel group is resolved, so the LEFT JOIN above lines
    // up on the same identity space (anon device -> firebase).
    cohortIds.forEach((cohortId) => {
      const cohortMeta = cohortMetadata.get(cohortId);
      const cohortQuery = buildCohortMembershipQuery(
        cohortId,
        projectId,
        cohortMeta,
        undefined,
        resolveAliases,
      );
      funnelQuery.with(getCohortCteName(cohortId), cohortQuery);
    });


    // Register the `filtered_profiles` pre-CTE + WHERE clause when the gate
    // above was satisfied. The funnelCte's main scan becomes
    // `WHERE profile_id IN (SELECT profile_id FROM filtered_profiles)`,
    // proj_funnel stays selected, and windowFunnel runs name-only matches
    // (the filters live in filtered_profiles, not in step conditions).
    if (filteredProfilesClauses.length > 0) {
      const funnelNamesIn = eventSeries
        .map((e) => sqlstring.escape(e.name))
        .join(', ');
      funnelQuery.with(
        'filtered_profiles',
        `SELECT DISTINCT profile_id
         FROM ${getEventsTableForRange(startDate)}
         WHERE project_id = ${sqlstring.escape(projectId)}
           AND name IN (${funnelNamesIn})
           AND created_at >= toDateTime('${formatClickhouseDate(startDate)}')
           AND created_at <= toDateTime('${formatClickhouseDate(endDate)}')
           AND profile_id != ''
           AND ${filteredProfilesClauses.join(' AND ')}`,
      );
      funnelCte.rawWhere(
        `${fromClause}.profile_id IN (SELECT profile_id FROM filtered_profiles)`,
      );
    }

    // Identity-merge alias map: join the event's profile_id to its canonical so the
    // group expression (resolveFunnelGroup) can collapse anon -> identified. One
    // scan of profile_aliases per query; empty for projects with no aliases.
    // Only emit the `al` CTE + JOIN when the dict is OFF; when on, the group
    // expression resolves via dictGet (in-RAM) and no scan/join is needed.
    if (resolveAliases && aliasResolutionNeedsCte()) {
      funnelCte.leftJoin('al', `al.alias = ${fromClause}.device_id`);
      funnelQuery.with(
        'al',
        clix(this.client, timezone)
          .select(['alias', 'argMax(profile_id, created_at) AS canonical'])
          .from(TABLE_NAMES.alias)
          .where('project_id', '=', projectId)
          .groupBy(['alias']),
      );
    }

    funnelQuery.with('funnel', funnelCte);

    funnelQuery
      .select<{
        level: number;
        count: number;
        [key: string]: any;
      }>([
        'level',
        ...breakdowns.map((b, index) => `b_${index}`),
        'count() as count',
      ])
      .from('funnel')
      .where('level', '!=', 0)
      .groupBy(['level', ...breakdowns.map((b, index) => `b_${index}`)])
      .orderBy('level', 'DESC');

    const funnelData = await funnelQuery.execute();
    const funnelSeries = this.toSeries(funnelData, breakdowns, limit);

    const funnelResult = funnelSeries
      .map((data) => {
        const maxLevel = eventSeries.length;
        const filledFunnelRes = this.fillFunnel(
          data.map((d) => ({ level: d.level, count: d.count })),
          maxLevel,
        );

        const totalSessions = last(filledFunnelRes)?.count ?? 0;
        const steps = reverse(filledFunnelRes)
          .reduce(
            (acc, item, index, list) => {
              const prev = list[index - 1] ?? { count: totalSessions };
              const next = list[index + 1];
              const event = eventSeries[item.level - 1]!;
              return [
                ...acc,
                {
                  event: {
                    ...event,
                    displayName: event.displayName || event.name,
                  },
                  count: item.count,
                  percent: (item.count / totalSessions) * 100,
                  dropoffCount: next ? item.count - next.count : null,
                  dropoffPercent: next
                    ? ((item.count - next.count) / item.count) * 100
                    : null,
                  previousCount: prev.count,
                  nextCount: next?.count ?? null,
                },
              ];
            },
            [] as {
              event: IChartEvent & { displayName: string };
              count: number;
              percent: number;
              dropoffCount: number | null;
              dropoffPercent: number | null;
              previousCount: number;
              nextCount: number | null;
            }[],
          )
          .map((step, index, list) => {
            return {
              ...step,
              percent: ifNaN(step.percent, 0),
              dropoffPercent: ifNaN(step.dropoffPercent, 0),
              isHighestDropoff: (() => {
                // Skip if current step has no dropoff
                if (!step?.dropoffCount) return false;

                // Get maximum dropoff count, excluding 0s
                const maxDropoff = Math.max(
                  ...list
                    .map((s) => s.dropoffCount || 0)
                    .filter((count) => count > 0),
                );

                // Check if this is the first step with the highest dropoff
                return (
                  step.dropoffCount === maxDropoff &&
                  list.findIndex((s) => s.dropoffCount === maxDropoff) === index
                );
              })(),
            };
          });

        return {
          id: data[0]?.id ?? 'none',
          breakdowns: data[0]?.breakdowns ?? [],
          steps,
          totalSessions,
          lastStep: last(steps)!,
          mostDropoffsStep: steps.find((step) => step.isHighestDropoff)!,
        };
      })
      .sort((a, b) => {
        const aTotal = a.steps.reduce((acc, step) => acc + step.count, 0);
        const bTotal = b.steps.reduce((acc, step) => acc + step.count, 0);
        return bTotal - aTotal;
      });

    // Compute time-to-convert if requested
    if (measuring === 'time_to_convert' && eventSeries.length >= 2) {
      const endDateObj = new Date(endDate);
      const extendedEndDateObj = new Date(endDateObj.getTime() + funnelWindowSeconds * 1000);
      const extendedEndDate = formatClickhouseDate(extendedEndDateObj);

      const firstEvent = eventSeries[0]!;
      const lastEventItem = eventSeries[eventSeries.length - 1]!;

      // Keep project_id / name / created_at in PREWHERE so ClickHouse can skip
      // granules using the sort key before reading other columns (profile_id,
      // properties, …). User-defined filters stay in WHERE — they may reference
      // map / high-cardinality columns where PREWHERE isn't a clear win.
      const firstEventWhere = firstEvent.filters && firstEvent.filters.length > 0
        ? '\n          WHERE ' + Object.values(getEventFiltersWhereClause(firstEvent.filters, projectId)).join(' AND ')
        : '';
      const lastEventWhere = lastEventItem.filters && lastEventItem.filters.length > 0
        ? '\n          WHERE ' + Object.values(getEventFiltersWhereClause(lastEventItem.filters, projectId)).join(' AND ')
        : '';

      const toStartOf = clix.toStartOf('fs.first_ts', interval || 'day');

      // Identity-merge: resolve profile_id -> canonical in both step CTEs so the
      // first/last-step JOIN stitches a user's anon and identified events. Mirrors
      // the main funnel; `gid` avoids shadowing the raw profile_id column. No-op
      // when the alias map is empty.
      const ttcAliasCte =
        resolveAliases && aliasResolutionNeedsCte()
          ? `al AS (
          SELECT alias, argMax(profile_id, created_at) AS canonical
          FROM ${TABLE_NAMES.alias}
          WHERE project_id = ${sqlstring.escape(projectId)}
          GROUP BY alias
        ),
        `
          : '';
      const ttcAliasJoin =
        resolveAliases && aliasResolutionNeedsCte()
          ? '\n          LEFT JOIN al ON al.alias = device_id'
          : '';
      const ttcGid = resolveAliases
        ? resolvedPersonIdSql(projectId, 'device_id', 'profile_id')
        : 'profile_id';

      const ttcQuery = `
        WITH
        ${ttcAliasCte}first_step_events AS (
          SELECT ${ttcGid} AS gid, min(created_at) AS first_ts
          FROM ${getEventsTableForRange(startDate)}${ttcAliasJoin}
          PREWHERE project_id = ${sqlstring.escape(projectId)}
            AND name = ${sqlstring.escape(firstEvent.name)}
            AND created_at >= toDateTime('${formatClickhouseDate(startDate)}')
            AND created_at <= toDateTime('${formatClickhouseDate(endDate)}')${firstEventWhere}
          GROUP BY gid
        ),
        last_step_events AS (
          SELECT ${ttcGid} AS gid, min(created_at) AS last_ts
          FROM ${getEventsTableForRange(startDate)}${ttcAliasJoin}
          PREWHERE project_id = ${sqlstring.escape(projectId)}
            AND name = ${sqlstring.escape(lastEventItem.name)}
            AND created_at >= toDateTime('${formatClickhouseDate(startDate)}')
            AND created_at <= toDateTime('${extendedEndDate}')${lastEventWhere}
          GROUP BY gid
        ),
        matched AS (
          SELECT
            ${toStartOf} AS event_day,
            dateDiff('second', fs.first_ts, ls.last_ts) AS time_diff_seconds
          FROM first_step_events fs
          JOIN last_step_events ls ON ls.gid = fs.gid
            AND ls.last_ts >= fs.first_ts
            AND ls.last_ts <= fs.first_ts + INTERVAL ${funnelWindowSeconds} SECOND
        )
        SELECT
          event_day,
          count() AS completed_count,
          round(avg(time_diff_seconds)) AS ttc_avg,
          round(quantile(0.5)(time_diff_seconds)) AS ttc_median,
          min(time_diff_seconds) AS ttc_min,
          max(time_diff_seconds) AS ttc_max,
          round(quantile(0.25)(time_diff_seconds)) AS ttc_p25,
          round(quantile(0.75)(time_diff_seconds)) AS ttc_p75,
          round(quantile(0.9)(time_diff_seconds)) AS ttc_p90,
          round(quantile(0.99)(time_diff_seconds)) AS ttc_p99
        FROM matched
        GROUP BY event_day
        ORDER BY event_day ASC
      `;

      const ttcResult = await this.client.query({
        query: ttcQuery,
        clickhouse_settings: { session_timezone: timezone },
      });
      const ttcJson = await ttcResult.json() as {
        data: {
          event_day: string;
          completed_count: number;
          ttc_avg: number;
          ttc_median: number;
          ttc_min: number;
          ttc_max: number;
          ttc_p25: number;
          ttc_p75: number;
          ttc_p90: number;
          ttc_p99: number;
        }[];
      };

      const timeToConvert = ttcJson.data.map(d => ({
        date: d.event_day,
        completedCount: Number(d.completed_count),
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
      }));

      return funnelResult.map(item => ({
        ...item,
        timeToConvert,
      }));
    }

    return funnelResult;
  }
}

export const funnelService = new FunnelService(ch);
