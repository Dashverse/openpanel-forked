import { flatten, map, omit, pipe, prop, range, sort, uniq } from 'ramda';
import sqlstring from 'sqlstring';
import { z } from 'zod';

import {
  type IClickhouseProfile,
  type IServiceProfile,
  TABLE_NAMES,
  aliasResolutionNeedsCte,
  ch,
  chQuery,
  clix,
  conversionService,
  createSqlBuilder,
  db,
  formatClickhouseDate,
  funnelService,
  getChartPrevStartEndDate,
  getChartStartEndDate,
  getEventFiltersWhereClause,
  getEventMetasCached,
  getProfilesCached,
  getSelectPropertyKey,
  getSettingsForProject,
  onlyReportEvents,
  operatorClause,
  resolvedPersonIdSql,
  resolvedProfileIdSql,
} from '@openpanel/db';
import {
  type IChartEvent,
  zChartEvent,
  zChartEventFilter,
  zChartInput,
  zChartSeries,
  zCriteria,
  zRange,
  zTimeInterval,
} from '@openpanel/validation';

import { round } from '@openpanel/common';
import { ChartEngine } from '@openpanel/db';
import {
  differenceInDays,
  differenceInMonths,
  differenceInWeeks,
  formatISO,
} from 'date-fns';
import { getProjectAccess } from '../access';
import { TRPCAccessError } from '../errors';
import {
  cacheMiddleware,
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from '../trpc';

function utc(date: string | Date) {
  if (typeof date === 'string') {
    return date.replace('T', ' ').slice(0, 19);
  }
  return formatISO(date).replace('T', ' ').slice(0, 19);
}

// Dashboard chart/funnel/conversion results are cached in Redis so that a page
// full of report widgets does not fan out into one ClickHouse query per widget
// on every (cold) load. Default 1h; tune via env. Set to 0 to disable.
const CHART_CACHE_TTL = Number.parseInt(
  process.env.CHART_CACHE_TTL_SECONDS || '3600',
  10,
);
// Fields that DON'T affect the query result but DO bloat / churn the cache key:
// - layout: changes on every widget drag/resize (createdAt/updatedAt) -> would
//   rewrite every report's key whenever the dashboard is rearranged.
// - id/name/lineType: presentational; identical configs should share a key.
// - dirty/ready: report-editor UI state (flip on every interaction).
// Stripping them keeps one cache entry per actual query (per range/interval),
// instead of multiplying by layout version, edit state, etc.
const CHART_KEY_OMIT = [
  'id',
  'name',
  'lineType',
  'layout',
  'dirty',
  'ready',
  'createdAt',
  'updatedAt',
];
const chartCacher = cacheMiddleware(CHART_CACHE_TTL, {
  keyInput: (raw) =>
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? omit(CHART_KEY_OMIT, raw)
      : raw,
});

export const chartRouter = createTRPCRouter({
  projectCard: protectedProcedure
    .use(cacheMiddleware(60 * 5))
    .input(
      z.object({
        projectId: z.string(),
      }),
    )
    .query(async ({ input: { projectId } }) => {
      const { timezone } = await getSettingsForProject(projectId);
      const chartPromise = chQuery<{
        value: number;
        date: Date;
        revenue: number;
      }>(
        `SELECT
            uniqHLL12(profile_id) as value,
            toStartOfDay(created_at) as date,
            sum(revenue * sign) as revenue
        FROM ${TABLE_NAMES.sessions}
        WHERE 
            project_id = ${sqlstring.escape(projectId)} AND 
            created_at >= now() - interval '3 month'
        GROUP BY date
        ORDER BY date ASC
        WITH FILL FROM toStartOfDay(now() - interval '1 month') 
        TO toStartOfDay(now()) 
        STEP INTERVAL 1 day
        SETTINGS session_timezone = '${timezone}'
      `,
      );

      const metricsPromise = clix(ch, timezone)
        .select<{
          months_3: number;
          months_3_prev: number;
          month: number;
          day: number;
          day_prev: number;
          revenue: number;
        }>([
          'uniqHLL12(if(created_at >= (now() - toIntervalMonth(3)), profile_id, null)) AS months_3',
          'uniqHLL12(if(created_at >= (now() - toIntervalMonth(6)) AND created_at < (now() - toIntervalMonth(3)), profile_id, null)) AS months_3_prev',
          'uniqHLL12(if(created_at >= (now() - toIntervalMonth(1)), profile_id, null)) AS month',
          'uniqHLL12(if(created_at >= (now() - toIntervalDay(1)), profile_id, null)) AS day',
          'uniqHLL12(if(created_at >= (now() - toIntervalDay(2)) AND created_at < (now() - toIntervalDay(1)), profile_id, null)) AS day_prev',
          'sum(revenue * sign) as revenue',
        ])
        .from(TABLE_NAMES.sessions)
        .where('project_id', '=', projectId)
        .where('created_at', '>=', clix.exp('now() - toIntervalMonth(6)'))
        .execute();

      const [chart, [metrics]] = await Promise.all([
        chartPromise,
        metricsPromise,
      ]);

      const change =
        metrics && metrics.months_3_prev > 0 && metrics.months_3 > 0
          ? Math.round(
              ((metrics.months_3 - metrics.months_3_prev) /
                metrics.months_3_prev) *
                100,
            )
          : null;

      const trend =
        change === null
          ? { direction: 'neutral' as const, percentage: null as number | null }
          : change > 0
            ? { direction: 'up' as const, percentage: change }
            : change < 0
              ? { direction: 'down' as const, percentage: Math.abs(change) }
              : { direction: 'neutral' as const, percentage: 0 };

      return {
        chart: chart.map((d) => ({ ...d, date: new Date(d.date) })),
        metrics,
        trend,
      };
    }),

  events: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
      }),
    )
    .query(async ({ input: { projectId } }) => {
      const [events, meta, customEvents] = await Promise.all([
        chQuery<{ name: string; count: number }>(
          `SELECT name, count(name) as count FROM ${TABLE_NAMES.event_names_mv} WHERE project_id = ${sqlstring.escape(projectId)} GROUP BY name ORDER BY count DESC, name ASC`,
        ),
        getEventMetasCached(projectId),
        db.customEvent.findMany({
          where: { projectId },
          select: { name: true, conversion: true },
        }),
      ]);

      const regularEvents = events.map((event) => ({
        name: event.name,
        count: event.count,
        meta: meta.find((m) => m.name === event.name),
        isCustom: false,
      }));

      const customEventsList = customEvents.map((ce) => ({
        name: ce.name,
        count: 0, // Custom events don't have pre-computed counts
        meta: {
          name: ce.name,
          conversion: ce.conversion,
        },
        isCustom: true,
      }));

      return [
        {
          name: '*',
          count: events.reduce((acc, event) => acc + event.count, 0),
          meta: undefined,
          isCustom: false,
        },
        ...regularEvents,
        ...customEventsList,
      ];
    }),

  properties: protectedProcedure
    .input(
      z.object({
        event: z.string().optional(),
        projectId: z.string(),
      }),
    )
    .query(async ({ input: { projectId, event } }) => {
      const profiles = await clix(ch, 'UTC')
        .select<Pick<IServiceProfile, 'properties'>>(['properties'])
        .from(TABLE_NAMES.profiles)
        .where('project_id', '=', projectId)
        .where('is_external', '=', true)
        .limit(10_000)
        .execute();

      // O(N×M) via Set instead of O(N²×M) via Array.includes(); much faster
      // and lower transient heap for projects with many profiles/properties.
      const profileProperties = [
        ...new Set(
          profiles.flatMap((p) =>
            Object.keys(p.properties).map((k) => `profile.properties.${k}`),
          ),
        ),
      ];

      const query = clix(ch)
        .select<{ property_key: string; created_at: string }>([
          'distinct property_key',
          'max(created_at) as created_at',
        ])
        .from(TABLE_NAMES.event_property_values_mv)
        .where('project_id', '=', projectId)
        .groupBy(['property_key'])
        // Shorter keys first (more useful in the picker UX); bounded result
        // so projects with millions of unique property keys don't blow the
        // heap on this endpoint.
        .orderBy('length(property_key)', 'ASC')
        .orderBy('created_at', 'DESC')
        .limit(10_000);

      if (event && event !== '*') {
        query.where('name', '=', event);
      }

      const res = await query.execute();

      const eventProperties = res.map((item) => {
        const key = item.property_key
          .replace(/\.([0-9]+)\./g, '.*.')
          .replace(/\.([0-9]+)/g, '[*]');
        return `properties.${key}`;
      });

      const fixedProperties = [
        'revenue',
        'has_profile',
        'path',
        'origin',
        'referrer',
        'referrer_name',
        'created_at',
        'country',
        'city',
        'region',
        'os',
        'os_version',
        'browser',
        'browser_version',
        'device',
        'brand',
        'model',
        'profile.id',
        'profile.first_name',
        'profile.last_name',
        'profile.email',
      ];

      const properties = [
        ...eventProperties,
        ...(event === '*' || !event ? ['name'] : []),
        ...fixedProperties,
        ...profileProperties,
      ];

      return pipe(
        sort<string>((a, b) => a.length - b.length),
        uniq,
      )(properties);
    }),

  values: protectedProcedure
    .input(
      z.object({
        event: z.string(),
        property: z.string(),
        projectId: z.string(),
      }),
    )
    .query(async ({ input: { event, property, projectId, ...input } }) => {
      if (property === 'has_profile') {
        return {
          values: ['true', 'false'],
        };
      }

      const values: string[] = [];

      if (property.startsWith('properties.')) {
        const query = clix(ch)
          .select<{
            property_value: string;
            created_at: string;
          }>(['distinct property_value', 'max(created_at) as created_at'])
          .from(TABLE_NAMES.event_property_values_mv)
          .where('project_id', '=', projectId)
          .where('property_key', '=', property.replace(/^properties\./, ''))
          .groupBy(['property_value'])
          .orderBy('created_at', 'DESC');

        if (event && event !== '*') {
          query.where('name', '=', event);
        }

        const res = await query.execute();

        values.push(...res.map((e) => e.property_value));
      } else {
        const query = clix(ch)
          .select<{ values: string[] }>([
            `distinct ${getSelectPropertyKey(property, projectId)} as values`,
          ])
          .from(TABLE_NAMES.events)
          .where('project_id', '=', projectId)
          .where('created_at', '>', clix.exp('now() - INTERVAL 6 MONTH'))
          .orderBy('created_at', 'DESC')
          .limit(100_000);

        if (event !== '*') {
          query.where('name', '=', event);
        }

        if (property.startsWith('profile.')) {
          query.leftAnyJoin(
            clix(ch)
              .select<IClickhouseProfile>([])
              .from(TABLE_NAMES.profiles)
              .where('project_id', '=', projectId),
            'profile.id = profile_id',
            'profile',
          );
        }

        const events = await query.execute();

        values.push(
          ...pipe(
            (data: typeof events) => map(prop('values'), data),
            flatten,
            uniq,
            sort((a, b) => a.length - b.length),
          )(events),
        );
      }

      return {
        values,
      };
    }),

  funnel: protectedProcedure
    .input(zChartInput)
    .use(chartCacher)
    .query(async ({ input }) => {
      const { timezone } = await getSettingsForProject(input.projectId);
      const currentPeriod = getChartStartEndDate(input, timezone);
      const previousPeriod = getChartPrevStartEndDate(currentPeriod);

      const [current, previous] = await Promise.all([
        funnelService.getFunnel({ ...input, ...currentPeriod, timezone }),
        input.previous
          ? funnelService.getFunnel({ ...input, ...previousPeriod, timezone })
          : Promise.resolve(null),
      ]);

      return {
        current,
        previous,
      };
    }),

  conversion: protectedProcedure
    .input(zChartInput)
    .use(chartCacher)
    .query(async ({ input }) => {
      const { timezone } = await getSettingsForProject(input.projectId);
      const currentPeriod = getChartStartEndDate(input, timezone);
      const previousPeriod = getChartPrevStartEndDate(currentPeriod);

      const [current, previous] = await Promise.all([
        conversionService.getConversion({
          ...input,
          ...currentPeriod,
          timezone,
        }),
        input.previous
          ? conversionService.getConversion({
              ...input,
              ...previousPeriod,
              timezone,
            })
          : Promise.resolve(null),
      ]);

      return {
        current: current.map((serie, sIndex) => ({
          ...serie,
          data: serie.data.map((d, dIndex) => ({
            ...d,
            previousRate: previous?.[sIndex]?.data?.[dIndex]?.rate,
          })),
        })),
        previous,
      };
    }),

  chart: publicProcedure
    .input(zChartInput)
    // Access must be enforced BEFORE the cache layer — a cache hit short-circuits
    // the resolver, so the access check cannot live inside it.
    .use(async ({ ctx, input, next }) => {
      const projectId = (input as { projectId: string }).projectId;
      const hasAccess = ctx.session.userId
        ? !!(await getProjectAccess({
            projectId,
            userId: ctx.session.userId,
          }))
        : false;

      if (!hasAccess) {
        const share = await db.shareOverview.findFirst({
          where: { projectId },
        });
        if (!share) {
          throw TRPCAccessError('You do not have access to this project');
        }
      }

      return next();
    })
    .use(chartCacher)
    .query(async ({ input }) => {
      // Use new chart engine
      return ChartEngine.execute(input);
    }),
  cohort: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        firstEvent: z.array(z.string()).min(1),
        secondEvent: z.array(z.string()).min(1),
        criteria: zCriteria.default('on_or_after'),
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        interval: zTimeInterval.default('day'),
        range: zRange,
        // Property filters on the cohort (first) event. Empty = name-only
        // retention (the #444 events + device_id path). Present = the cohort
        // event is restricted to that property, sourced from the anon-inclusive
        // v2 property MV within its window (else raw events). cohortId filters
        // are accepted but ignored here (cohort-filter support is a follow-up).
        filters: z.array(zChartEventFilter).default([]),
      }),
    )
    .query(async ({ input }) => {
      const { timezone } = await getSettingsForProject(input.projectId);
      const { projectId, firstEvent, secondEvent } = input;
      const dates = getChartStartEndDate(input, timezone);
      const diffInterval = {
        minute: () => differenceInDays(dates.endDate, dates.startDate),
        hour: () => differenceInDays(dates.endDate, dates.startDate),
        day: () => differenceInDays(dates.endDate, dates.startDate),
        week: () => differenceInWeeks(dates.endDate, dates.startDate),
        month: () => differenceInMonths(dates.endDate, dates.startDate),
      }[input.interval]();
      const sqlInterval = {
        minute: 'DAY',
        hour: 'DAY',
        day: 'DAY',
        week: 'WEEK',
        month: 'MONTH',
      }[input.interval];

      const sqlToStartOf = {
        minute: 'toDate',
        hour: 'toDate',
        day: 'toDate',
        week: 'toStartOfWeek',
        month: 'toStartOfMonth',
      }[input.interval];

      const countCriteria = input.criteria === 'on_or_after' ? '>=' : '=';

      const usersSelect = range(0, diffInterval + 1)
        .map(
          (index) =>
            `groupUniqArrayIf(profile_id, x_after_cohort ${countCriteria} ${index}) AS interval_${index}_users`,
        )
        .join(',\n');

      const countsSelect = range(0, diffInterval + 1)
        .map(
          (index) =>
            `length(interval_${index}_users) AS interval_${index}_user_count`,
        )
        .join(',\n');

      const whereEventNameIs = (event: string[]) => {
        if (event.length === 1) {
          return `name = ${sqlstring.escape(event[0])}`;
        }
        return `name IN (${event.map((e) => sqlstring.escape(e)).join(',')})`;
      };

      // Retention reads raw `events` (anon-inclusive) instead of the
      // anon-excluding `cohort_events_mv` (WHERE profile_id != device_id), and
      // resolves each event to its canonical person so a user's anon +
      // identified events — and logins across devices — collapse to one.
      //
      // Identity + source depend on whether there's a property filter:
      //  - name-only  -> both CTEs read `events`, resolve on `device_id`
      //    (resolvedPersonIdSql) — the #444 path.
      //  - property   -> resolve on `profile_id` (resolvedProfileIdSql) on BOTH
      //    sides (the v2 property MV has no `device_id`, so both sides must share
      //    ONE identity space — mixing device_id + profile_id would miscount).
      //    The COHORT event is sourced from the anon-inclusive v2 property MV
      //    (property_key/property_value, pre-aggregated) when the range starts
      //    in its window (PROPERTY_MV_V2_MIN_DATE, Jul 1), else from raw `events`
      //    with the property matched on its MATERIALIZED column
      //    (getSelectPropertyKey). The RETURN event stays name-only on `events`.
      // Dict off (self-hosted) -> raw `profile_id`: unchanged identity, still
      // anon-inclusive. Columns are table-qualified so the resolved expression's
      // inner `profile_id` binds to the column, not the `AS profile_id` output
      // alias (the #432 NOT_AN_AGGREGATE / ambiguous-identifier trap).
      const E = TABLE_NAMES.events;
      const V2 = TABLE_NAMES.profile_event_property_summary_v2;
      const dictOff = aliasResolutionNeedsCte();

      const propertyFilters = input.filters.filter(
        (f) =>
          !f.cohortId &&
          f.name.startsWith('properties.') &&
          Array.isArray(f.value) &&
          f.value.length > 0,
      );
      const hasPropertyFilter = propertyFilters.length > 0;
      const v2MinDate = process.env.PROPERTY_MV_V2_MIN_DATE?.trim();
      const cohortUsesV2 =
        hasPropertyFilter &&
        !!v2MinDate &&
        utc(dates.startDate).slice(0, 10) >= v2MinDate.slice(0, 10);

      // Person expr for raw `events`: profile_id-keyed when property-filtered,
      // else device_id-keyed (#444).
      const eventsPerson = dictOff
        ? `${E}.profile_id`
        : hasPropertyFilter
          ? resolvedProfileIdSql(projectId, `${E}.profile_id`)
          : resolvedPersonIdSql(projectId, `${E}.device_id`, `${E}.profile_id`);

      const cohortUsersCte = cohortUsesV2
        ? `
        cohort_users AS (
          SELECT
            ${dictOff ? 'profile_id' : resolvedProfileIdSql(projectId, `${V2}.profile_id`)} AS userID,
            ${sqlToStartOf}(event_date) AS cohort_interval
          FROM ${V2}
          WHERE ${whereEventNameIs(firstEvent)}
            AND project_id = ${sqlstring.escape(projectId)}
            AND event_date BETWEEN toDate('${utc(dates.startDate)}') AND toDate('${utc(dates.endDate)}')
            AND (${propertyFilters
              .map(
                (f) =>
                  `(property_key = ${sqlstring.escape(f.name.replace('properties.', ''))} AND ${operatorClause('property_value', f.operator, f.value)})`,
              )
              .join(' OR ')})
          GROUP BY userID, cohort_interval
        )`
        : `
        cohort_users AS (
          SELECT
            ${eventsPerson} AS userID,
            ${sqlToStartOf}(created_at) AS cohort_interval
          FROM ${E}
          WHERE ${whereEventNameIs(firstEvent)}
            AND project_id = ${sqlstring.escape(projectId)}
            AND created_at BETWEEN toDate('${utc(dates.startDate)}') AND toDate('${utc(dates.endDate)}')
            ${
              hasPropertyFilter
                ? `AND (${propertyFilters
                    .map(
                      (f) =>
                        `(${operatorClause(getSelectPropertyKey(f.name, projectId), f.operator, f.value)})`,
                    )
                    .join(' OR ')})`
                : ''
            }
        )`;

      const cohortQuery = `
        WITH
        ${cohortUsersCte},
        last_event AS
        (
            SELECT
                ${eventsPerson} AS profile_id,
                toDate(created_at) AS event_date
            FROM ${E}
            WHERE ${whereEventNameIs(secondEvent)}
            AND project_id = ${sqlstring.escape(projectId)}
            AND created_at BETWEEN toDate('${utc(dates.startDate)}') AND toDate('${utc(dates.endDate)}') + INTERVAL ${diffInterval} ${sqlInterval}
        ),
        retention_matrix AS
        (
          SELECT
              f.cohort_interval,
              l.profile_id,
              dateDiff('${sqlInterval}', f.cohort_interval, ${sqlToStartOf}(l.event_date)) AS x_after_cohort
          FROM cohort_users AS f
          INNER JOIN last_event AS l ON f.userID = l.profile_id
          WHERE (l.event_date >= f.cohort_interval) 
          AND (l.event_date <= (f.cohort_interval + INTERVAL ${diffInterval} ${sqlInterval}))
        ),
        interval_users AS (
          SELECT
            cohort_interval,
            ${usersSelect}
          FROM retention_matrix
          GROUP BY cohort_interval
        ),
        cohort_sizes AS (
          SELECT
            cohort_interval,
            COUNT(DISTINCT userID) AS total_first_event_count
          FROM cohort_users
          GROUP BY cohort_interval
        )
        SELECT
          interval_users.cohort_interval,
          cs.total_first_event_count,
          ${countsSelect}
        FROM interval_users
        LEFT JOIN cohort_sizes AS cs ON interval_users.cohort_interval = cs.cohort_interval
        ORDER BY interval_users.cohort_interval ASC
      `;

      const cohortData = await chQuery<{
        cohort_interval: string;
        total_first_event_count: number;
        [key: string]: any;
      }>(cohortQuery);

      return processCohortData(cohortData, diffInterval);
    }),

  getProfiles: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        date: z.string().describe('The date for the data point (ISO string)'),
        interval: zTimeInterval.default('day'),
        series: zChartSeries,
        breakdowns: z.record(z.string(), z.string()).optional(),
      }),
    )
    .query(async ({ input }) => {
      const { timezone } = await getSettingsForProject(input.projectId);
      const { projectId, date, series } = input;
      const limit = 1000;
      const serie = series[0];

      if (!serie) {
        throw new Error('Series not found');
      }

      if (serie.type !== 'event') {
        throw new Error('Series must be an event');
      }

      // Build the date range for the specific interval bucket
      const dateObj = new Date(date);
      // Build query to get unique profile_ids for this time bucket
      const { sb, getSql } = createSqlBuilder();

      sb.select.profile_id = 'DISTINCT profile_id';
      sb.where = getEventFiltersWhereClause(serie.filters);
      sb.where.projectId = `project_id = ${sqlstring.escape(projectId)}`;
      sb.where.dateRange = `${clix.toStartOf('created_at', input.interval)} = ${clix.toDate(sqlstring.escape(formatClickhouseDate(dateObj)), input.interval)}`;
      if (serie.name !== '*') {
        sb.where.eventName = `name = ${sqlstring.escape(serie.name)}`;
      }

      // Collect profile fields from filters and breakdowns
      const profileFields = [
        ...serie.filters
          .filter((f) => f.name.startsWith('profile.'))
          .map((f) => f.name.replace('profile.', '')),
        ...(input.breakdowns
          ? Object.keys(input.breakdowns)
              .filter((key) => key.startsWith('profile.'))
              .map((key) => key.replace('profile.', ''))
          : []),
      ];

      if (profileFields.length > 0) {
        // Extract top-level field names and select only what's needed
        const fieldsToSelect = uniq(
          profileFields.map((f) => f.split('.')[0]),
        ).join(', ');
        sb.joins.profiles = `LEFT ANY JOIN (SELECT id, ${fieldsToSelect} FROM ${TABLE_NAMES.profiles} FINAL WHERE project_id = ${sqlstring.escape(projectId)}) as profile on profile.id = profile_id`;
      }

      if (input.breakdowns) {
        Object.entries(input.breakdowns).forEach(([key, value]) => {
          // Transform property keys (e.g., properties.method -> properties['method'])
          const propertyKey = getSelectPropertyKey(key, projectId);
          sb.where[`breakdown_${key}`] =
            `${propertyKey} = ${sqlstring.escape(value)}`;
        });
      }

      // Cap the preview list. The declared `limit` was never applied here, so this
      // endpoint returned ALL profile_ids for the bucket — on a high-traffic day
      // getProfilesCached then inlines tens of thousands of ids into the Redis cache
      // key -> "ERR key name too long" (same crash the funnel view-users hit).
      sb.limit = limit;

      // Get unique profile IDs
      const profileIds = await chQuery<{ profile_id: string }>(getSql());
      if (profileIds.length === 0) {
        return [];
      }

      // Fetch profile details
      const ids = profileIds.map((p) => p.profile_id).filter(Boolean);
      const profiles = await getProfilesCached(ids, projectId);

      return profiles;
    }),

  getFunnelProfiles: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        series: zChartSeries,
        stepIndex: z.number().describe('0-based index of the funnel step'),
        showDropoffs: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'If true, show users who dropped off at this step. If false, show users who completed at least this step.',
          ),
        funnelWindow: z.number().optional(),
        funnelGroup: z.string().optional(),
        breakdowns: z.array(z.object({ name: z.string() })).optional(),
        range: zRange,
      }),
    )
    .query(async ({ input }) => {
      const { timezone } = await getSettingsForProject(input.projectId);
      const {
        projectId,
        series,
        stepIndex,
        showDropoffs = false,
        funnelWindow,
        funnelGroup,
        breakdowns = [],
      } = input;

      const { startDate, endDate } = getChartStartEndDate(input, timezone);

      // stepIndex is 0-based, but level is 1-based, so we need level >= stepIndex + 1
      const targetLevel = stepIndex + 1;

      const eventSeries = onlyReportEvents(series);

      if (eventSeries.length === 0) {
        throw new Error('At least one event series is required');
      }

      const funnelWindowSeconds = (funnelWindow || 24) * 3600;
      const funnelWindowMilliseconds = funnelWindowSeconds * 1000;

      // Resolve events source (handles custom events) and funnel group column
      const { fromClause, withClauses, needsNameFilter } =
        await funnelService.buildEventsSource(
          eventSeries as IChartEvent[],
          projectId,
          startDate,
          endDate,
        );

      // Identity-merge: resolve anon profile_id -> canonical via profile_aliases so
      // the user list keys on the SAME canonical id the count funnel (getFunnel) uses.
      // Without this, the list emitted raw/session ids that don't match profiles.id,
      // so getProfilesCached dropped them all -> "No users found" even when the
      // dropoff count was > 0. Profile-level only (no cohorts in this procedure).
      const resolveAliases = funnelGroup !== 'session_id';
      const group = funnelService.resolveFunnelGroup(
        funnelGroup,
        fromClause,
        resolveAliases,
        projectId,
      );
      const groupedByProfile = group[1] === 'profile_id';

      // When grouped by profile_id, the group column is already aliased to
      // profile_id; only add a separate profile_id select in session-grouped mode.
      const funnelCte = funnelService.buildFunnelCte({
        projectId,
        startDate,
        endDate,
        eventSeries: eventSeries as IChartEvent[],
        funnelWindowMilliseconds,
        group,
        timezone,
        additionalSelects: groupedByProfile
          ? []
          : [`${fromClause}.profile_id AS profile_id`],
        additionalGroupBy: groupedByProfile ? [] : ['profile_id'],
        fromClause,
        needsNameFilter,
      });

      // Check for profile filters and add profile join if needed
      const profileFilters = funnelService.getProfileFilters(
        eventSeries as IChartEvent[],
      );
      if (profileFilters.length > 0) {
        const fieldsToSelect = uniq(
          profileFilters.map((f) => f.split('.')[0]),
        ).join(', ');
        funnelCte.leftJoin(
          `(SELECT id, ${fieldsToSelect} FROM ${TABLE_NAMES.profiles} FINAL WHERE project_id = ${sqlstring.escape(projectId)}) as profile`,
          `profile.id = ${fromClause}.profile_id`,
        );
      }

      // Build main query
      const query = clix(ch, timezone);

      // Register custom-event CTEs (if any) on the outer query
      for (const withClause of withClauses) {
        query.with(withClause.name, withClause.query);
      }

      // Identity-merge alias map — mirrors getFunnel (funnel.service.ts:782-791). Join
      // each event's profile_id to its canonical id so resolveFunnelGroup's coalesce
      // collapses anon -> identified, yielding real profiles.id values. One scan of
      // profile_aliases; a no-op for projects with no aliases (coalesce keeps raw id).
      if (resolveAliases) {
        funnelCte.leftJoin('al', `al.alias = ${fromClause}.device_id`);
        query.with(
          'al',
          clix(ch, timezone)
            .select(['alias', 'argMax(profile_id, created_at) AS canonical'])
            .from(TABLE_NAMES.alias)
            .where('project_id', '=', projectId)
            .groupBy(['alias']),
        );
      }

      query.with('funnel', funnelCte);

      // Get distinct profile IDs
      query
        .select(['DISTINCT profile_id'])
        .from('funnel')
        .where('level', '!=', 0);

      if (showDropoffs) {
        // Show users who dropped off at this step (completed this step but not the next)
        query.where('level', '=', targetLevel);
      } else {
        // Show users who completed at least this step
        query.where('level', '>=', targetLevel);
      }

      // "View Users" is a preview list — cap it. Large cohorts (e.g. all completers)
      // returned tens of thousands of ids, which getProfilesCached inlines into the
      // Redis cache key -> multi-MB key -> "ERR key name too long". Top 1000 for now;
      // pagination can extend this later.
      query.limit(1000);

      const profileIdsResult = (await query.execute()) as {
        profile_id: string;
      }[];

      if (profileIdsResult.length === 0) {
        return [];
      }

      // Fetch profile details
      const ids = profileIdsResult.map((p) => p.profile_id).filter(Boolean);
      const profiles = await getProfilesCached(ids, projectId);

      return profiles;
    }),
});

function processCohortData(
  data: Array<{
    cohort_interval: string;
    total_first_event_count: number;
    [key: string]: any;
  }>,
  diffInterval: number,
) {
  if (data.length === 0) {
    return [];
  }

  const processed = data.map((row) => {
    const sum = row.total_first_event_count;
    const values = range(0, diffInterval + 1).map(
      (index) => (row[`interval_${index}_user_count`] || 0) as number,
    );

    return {
      cohort_interval: row.cohort_interval,
      sum,
      values: values,
      percentages: values.map((value) => (sum > 0 ? round(value / sum, 2) : 0)),
    };
  });

  const averageData: {
    totalSum: number;
    values: Array<{ sum: number; weightedSum: number }>;
    percentages: Array<{ sum: number; weightedSum: number }>;
  } = {
    totalSum: 0,
    values: range(0, diffInterval + 1).map(() => ({ sum: 0, weightedSum: 0 })),
    percentages: range(0, diffInterval + 1).map(() => ({
      sum: 0,
      weightedSum: 0,
    })),
  };

  // Aggregate data for weighted averages, excluding zeros
  processed.forEach((row) => {
    averageData.totalSum += row.sum;
    row.values.forEach((value, index) => {
      if (value !== 0) {
        averageData.values[index]!.sum += row.sum;
        averageData.values[index]!.weightedSum += value * row.sum;
      }
    });
    row.percentages.forEach((percentage, index) => {
      if (percentage !== 0) {
        averageData.percentages[index]!.sum += row.sum;
        averageData.percentages[index]!.weightedSum += percentage * row.sum;
      }
    });
  });

  // Calculate weighted average values, excluding zeros
  const averageRow = {
    cohort_interval: 'Weighted Average',
    sum: round(averageData.totalSum / processed.length, 0),
    percentages: averageData.percentages.map(({ sum, weightedSum }) =>
      sum > 0 ? round(weightedSum / sum, 2) : 0,
    ),
    values: averageData.values.map(({ sum, weightedSum }) =>
      sum > 0 ? round(weightedSum / sum, 0) : 0,
    ),
  };

  return [averageRow, ...processed];
}
