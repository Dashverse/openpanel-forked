import { flatten, map, omit, pipe, prop, range, sort, uniq } from 'ramda';
import sqlstring from 'sqlstring';
import { z } from 'zod';

import {
  type IClickhouseProfile,
  type IServiceProfile,
  TABLE_NAMES,
  buildRetentionQuery,
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
  processRetentionData,
} from '@openpanel/db';
import {
  zChartEvent,
  zChartEventFilter,
  zChartInput,
  zChartInputBase,
  zChartSeries,
  zCriteria,
  zRange,
  zTimeInterval,
} from '@openpanel/validation';

import { round } from '@openpanel/common';
import { ChartEngine } from '@openpanel/db';
import { getProjectAccess } from '../access';
import { TRPCAccessError } from '../errors';
import {
  cacheMiddleware,
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from '../trpc';

// Dashboard chart/funnel/conversion results are cached in Redis so that a page
// full of report widgets does not fan out into one ClickHouse query per widget
// on every (cold) load. Default 1h; tune via env. Set to 0 to disable.
const CHART_CACHE_TTL = Number.parseInt(
  process.env.CHART_CACHE_TTL_SECONDS || '3600',
  10,
);
// `chart.values` for a TOP-LEVEL column (country, os, city, device…) has no MV,
// so it did `SELECT DISTINCT <col> FROM events WHERE created_at > now()-6 MONTH`
// — a full 6-month scan that hit max_execution_time every time and returned
// nothing (a single dashreels `country` dropdown on a refetch loop burned
// ~320s / 768 GB of CH time per hour, 100% timeouts). A filter-value dropdown
// only needs recently-seen values, so clamp the lookback (~6x less scan).
// Env-tunable; the property-MV fast path (properties.*) is unaffected.
const VALUES_LOOKBACK_DAYS = Number.parseInt(
  process.env.CHART_VALUES_LOOKBACK_DAYS || '30',
  10,
);
// Top-level columns whose distinct values also live on the far smaller
// `sessions` table (one row per session, geo/device/referrer denormalised onto
// every event). For an all-events (`*`) value dropdown we read these from
// `sessions` instead of scanning billions of `events` rows — same value set,
// ~170x faster (dashreels country: 0.12s / 15M rows vs 20.7s / 3.2B rows).
// `path`/`origin` are per-pageview (not on sessions) and fall back to events.
const SESSION_LEVEL_VALUE_COLUMNS = new Set([
  'country',
  'region',
  'city',
  'os',
  'os_version',
  'browser',
  'browser_version',
  'device',
  'brand',
  'model',
  'referrer',
  'referrer_name',
  'referrer_type',
]);
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

// Funnel step drill-down input: the chart's own input (so the people query is
// built exactly like the counts) plus which step / side / breakdown row.
const zFunnelStepPeopleInput = zChartInputBase.extend({
  stepIndex: z.number().int().min(0).describe('0-based index of the funnel step'),
  showDropoffs: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'If true, people who reached this step but not the next. If false, people who completed at least this step.',
    ),
  breakdownValues: z
    .array(z.string().nullable())
    .optional()
    .describe('Values of the clicked breakdown row, in breakdown order'),
});

async function getFunnelStepPeople(
  input: z.infer<typeof zFunnelStepPeopleInput>,
  opts: { onlyWithReplay: boolean; maxPeople: number },
) {
  const { timezone } = await getSettingsForProject(input.projectId);
  // Same date resolution as the `funnel` procedure so the range matches the chart.
  const currentPeriod = getChartStartEndDate(input, timezone);
  return funnelService.getFunnelPeople({
    ...input,
    ...currentPeriod,
    timezone,
    ...opts,
  });
}

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

      // Keys only — no max(created_at). Selecting just (project_id, name,
      // property_key) lets ClickHouse answer from the proj_event_keys
      // aggregate projection (~1M rows) instead of scanning every stored value
      // (~268M rows on dashreels, ~900ms). A last-seen tie-break isn't worth
      // that: the list is re-sorted by length below anyway.
      const query = clix(ch)
        .select<{ property_key: string }>(['property_key'])
        .from(TABLE_NAMES.event_property_values_mv)
        .where('project_id', '=', projectId)
        .groupBy(['property_key'])
        // Shorter keys first (more useful in the picker UX); bounded result
        // so projects with millions of unique property keys don't blow the
        // heap on this endpoint.
        .orderBy('length(property_key)', 'ASC')
        .orderBy('property_key', 'ASC')
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
        // Optional: the filter UI leaves this unset when the event selector is
        // on "All Events". Missing/empty is treated the same as '*' below, so
        // values populate across all events instead of the query 400ing on a
        // required-string input and the dropdown coming back empty.
        event: z.string().optional(),
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
        // Read session-level columns (geo/device/referrer) from the tiny
        // `sessions` table instead of scanning billions of `events` rows. Only
        // when querying all events (`*` or unset) and not a profile.* column —
        // sessions has no `name` column and no profile join.
        const useSessions =
          (event === '*' || !event) &&
          !property.startsWith('profile.') &&
          SESSION_LEVEL_VALUE_COLUMNS.has(property);

        const query = clix(ch)
          .select<{ values: string[] }>([
            `distinct ${getSelectPropertyKey(property, projectId)} as values`,
          ])
          .from(useSessions ? TABLE_NAMES.sessions : TABLE_NAMES.events)
          .where('project_id', '=', projectId)
          .where(
            'created_at',
            '>',
            clix.exp(`now() - INTERVAL ${VALUES_LOOKBACK_DAYS} DAY`),
          )
          .orderBy('created_at', 'DESC')
          .limit(100_000);

        if (!useSessions && event && event !== '*') {
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
        firstEventFilters: z.array(zChartEventFilter).default([]),
        secondEventFilters: z.array(zChartEventFilter).default([]),
      }),
    )
    .query(async ({ input }) => {
      const { timezone } = await getSettingsForProject(input.projectId);
      const { projectId, firstEvent, secondEvent } = input;
      const dates = getChartStartEndDate(input, timezone);
      const { sql: cohortQuery, diffInterval } = buildRetentionQuery({
        projectId,
        firstEvent,
        secondEvent,
        criteria: input.criteria,
        interval: input.interval,
        startDate: dates.startDate,
        endDate: dates.endDate,
        firstEventFilters: input.firstEventFilters,
        secondEventFilters: input.secondEventFilters,
      });

      const cohortData = await chQuery<{
        cohort_interval: string;
        total_first_event_count: number;
        [key: string]: any;
      }>(cohortQuery);

      return processRetentionData(cohortData, diffInterval);
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

  // "View users" on a funnel step. The list comes from the SAME per-person
  // query as the chart counts (funnelService.getFunnelPeople → getFunnel's
  // builder): same global filters, hold properties, cohorts, identity
  // resolution, first-time qualifiers and breakdown row — so `total` always
  // equals the step's completed / dropped-off count.
  getFunnelProfiles: protectedProcedure
    .input(zFunnelStepPeopleInput)
    .query(async ({ input }) => {
      const { people, total, totalPeople } = await getFunnelStepPeople(input, {
        onlyWithReplay: false,
        // "View Users" is a preview list — cap it. getProfilesCached inlines
        // every id into its Redis cache key, so tens of thousands of ids blew
        // up with "ERR key name too long".
        maxPeople: 1000,
      });

      const ids = people.map((p) => p.profileId).filter(Boolean);
      const profiles = ids.length
        ? await getProfilesCached(ids, input.projectId)
        : [];
      // Keep the query's order (most recent step first).
      const byId = new Map(profiles.map((p) => [p.id, p]));
      return {
        total,
        totalPeople,
        profiles: uniq(ids)
          .map((id) => byId.get(id))
          .filter((p): p is IServiceProfile => !!p),
      };
    }),

  // "View replays" on a funnel step: the same population as getFunnelProfiles,
  // narrowed to people whose step session has a recording, each with the
  // session / tab / time of the step so the player can open right there.
  getFunnelReplays: protectedProcedure
    .input(zFunnelStepPeopleInput)
    .query(async ({ input }) => {
      const { people, total, totalPeople, totalWithReplay } =
        await getFunnelStepPeople(input, {
          onlyWithReplay: true,
          maxPeople: 200,
        });

      const ids = people.map((p) => p.profileId).filter(Boolean);
      const profiles = ids.length
        ? await getProfilesCached(ids, input.projectId)
        : [];
      const byId = new Map(profiles.map((p) => [p.id, p]));
      return {
        total,
        totalPeople,
        totalWithReplay,
        replays: people.map((p) => ({
          profileId: p.profileId,
          // null when the person has no profiles row (e.g. never identified).
          profile: byId.get(p.profileId) ?? null,
          sessionId: p.sessionId,
          windowId: p.windowId,
          stepAt: p.stepAt,
        })),
      };
    }),
});
