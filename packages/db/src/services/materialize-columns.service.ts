import { type ILogger, createLogger } from '@openpanel/logger';
import { ch } from '../clickhouse/client';
import { chMigrationClient } from '../clickhouse/migration';
import { db } from '../../index';
import { refreshMaterializedColumnsCache } from './chart.service';

interface PropertyUsageStats {
  property: string; // Full path: "properties.utm_source" or "profile.properties.campaign"
  propertyKey: string; // Key only: "utm_source" or "campaign"
  targetTable: 'events' | 'profiles'; // Which ClickHouse table to materialize on
  usageCount: number; // How many reports use it
  queryFrequency: number; // Estimated queries per day
  cardinality: number; // Number of unique values (0 when using query-log path; see enrichWithQueryLogStats)
  estimatedSize: number; // Estimated storage cost in bytes (0 when using query-log path)
  benefit: number; // Calculated benefit score
  // Pain signal from system.query_log (query-log-driven analysis):
  // — populated by `enrichWithQueryLogStats`; all zero when a property has
  //   no observed slow queries. Kept optional so the shape stays compatible
  //   with any consumers of PropertyUsageStats that only care about
  //   report-derived usage stats.
  observedOccurrences?: number;
  observedTimeouts?: number;
  observedSlowCount?: number;
  observedTotalMs?: number;
}

interface PropertyAnalysis extends PropertyUsageStats {
  skipReason?: string; // Why it wasn't materialized (if skipped)
}

interface MaterializedColumnCandidate {
  propertyKey: string;
  columnName: string;
  targetTable: 'events' | 'profiles';
  reason: string;
  stats: PropertyUsageStats;
}

export class MaterializeColumnsService {
  private logger: ILogger;

  // Thresholds for materialization decisions
  private readonly MIN_USAGE_COUNT = 1; // Must be used in at least 1 report
  private readonly MAX_CARDINALITY = 5000; // Don't materialize if >5000 unique values (only checked when USE_QUERY_LOG_PAIN_SIGNAL=false)
  private readonly MIN_BENEFIT_SCORE = 20; // Minimum benefit score to justify materialization
  private readonly MAX_DAILY_MATERIALIZATIONS = 3; // Rate limit: max 3 new columns per day (total across both tables)

  // Query-log-driven analyzer knobs. Only consulted when
  // USE_QUERY_LOG_PAIN_SIGNAL === true (default). Left tunable via env for
  // scale-specific tuning without a code deploy — PostHog uses 20 GB / 5M
  // rows / >slow_min at their scale; ours is smaller so defaults are looser.
  private readonly QUERY_LOG_WINDOW_HOURS = Number.parseInt(
    process.env.MATERIALIZE_QUERY_LOG_WINDOW_HOURS || '168', // 7 days
    10,
  );
  private readonly QUERY_LOG_SLOW_MS = Number.parseInt(
    process.env.MATERIALIZE_QUERY_LOG_SLOW_MS || '2000', // 2s
    10,
  );
  private readonly QUERY_LOG_MIN_SLOW_COUNT = Number.parseInt(
    process.env.MATERIALIZE_QUERY_LOG_MIN_SLOW_COUNT || '3',
    10,
  );

  // Feature flag — default ON. Set MATERIALIZE_USE_QUERY_LOG=false to
  // fall back to the original report-scan + source-table cardinality probe.
  private readonly USE_QUERY_LOG_PAIN_SIGNAL =
    process.env.MATERIALIZE_USE_QUERY_LOG !== 'false';

  constructor() {
    this.logger = createLogger({ name: 'materialize-columns' });
  }

  /**
   * Main entry point with dry-run support
   */
  async analyze(options: {
    dryRun: boolean;
    threshold?: number;
  }): Promise<{
    candidates: MaterializedColumnCandidate[];
    allProperties: PropertyAnalysis[];
    report: string;
    materialized: string[];
  }> {
    const { dryRun, threshold = this.MIN_BENEFIT_SCORE } = options;

    this.logger.info('Starting materialized column analysis', {
      dryRun,
      threshold,
    });

    // Run both pipelines: events first, then profiles
    const { candidates: eventsCandidates, allProperties: eventsProperties } =
      await this.analyzeDashboardProperties('events', threshold);

    const { candidates: profilesCandidates, allProperties: profilesProperties } =
      await this.analyzeDashboardProperties('profiles', threshold);

    const candidates = [...eventsCandidates, ...profilesCandidates];
    const allProperties = [...eventsProperties, ...profilesProperties];

    // Generate combined report
    const report = this.generateReport(candidates, allProperties, dryRun);

    // Execute if not dry-run
    const materialized: string[] = [];
    if (!dryRun && candidates.length > 0) {
      // Rate limiting across both tables combined
      const limited = candidates.slice(0, this.MAX_DAILY_MATERIALIZATIONS);
      if (limited.length < candidates.length) {
        this.logger.warn(
          `Rate limiting: Only materializing ${limited.length} of ${candidates.length} candidates`,
        );
      }

      for (const candidate of limited) {
        try {
          await this.materializeColumn(candidate);
          materialized.push(`${candidate.targetTable}:${candidate.propertyKey}`);
        } catch (error) {
          this.logger.error(
            `Failed to materialize ${candidate.targetTable}:${candidate.propertyKey}`,
            { error },
          );
        }
      }
    }

    return {
      candidates,
      allProperties,
      report,
      materialized,
    };
  }

  /**
   * Main analysis function for a specific target table
   */
  private async analyzeDashboardProperties(
    targetTable: 'events' | 'profiles',
    threshold: number,
  ): Promise<{
    candidates: MaterializedColumnCandidate[];
    allProperties: PropertyAnalysis[];
  }> {
    const propertyUsage = targetTable === 'events'
      ? await this.getEventsPropertyUsageFromReports()
      : await this.getProfilePropertyUsageFromReports();

    if (propertyUsage.length === 0) {
      this.logger.info(`No ${targetTable} properties found in reports`);
      return { candidates: [], allProperties: [] };
    }

    this.logger.info(`Found ${propertyUsage.length} unique ${targetTable} properties in reports`);

    // Check already tracked in database
    const existingColumns = await db.materializedColumn.findMany({
      where: { status: 'active', targetTable },
      select: { propertyKey: true },
    });
    const existingKeys = new Set(existingColumns.map((c) => c.propertyKey));

    // Pull every column on the target table — we need both the names
    // (to detect collisions with reserved top-level columns like `name`,
    // `session_id`, `country`, etc.) AND each column's default_kind
    // (so we can tell "already materialized → skip" from
    // "regular column collision → rename to prop_<key>").
    const clickhouseColumns = await this.getExistingClickHouseColumns(targetTable);
    const materializedColumnNames = new Set(
      Array.from(clickhouseColumns.entries())
        .filter(([, kind]) => kind === 'MATERIALIZED')
        .map(([name]) => name),
    );
    const allColumnNames = new Set(clickhouseColumns.keys());

    const alreadyTracked = propertyUsage.filter((p) => existingKeys.has(p.propertyKey));
    // Only skip when the existing column is itself a materialized projection of
    // this property — a regular column with the same name (e.g. `name`,
    // `country`) is a collision we want to handle by renaming, not skipping.
    const alreadyExistsInClickHouse = propertyUsage.filter(
      (p) => !existingKeys.has(p.propertyKey) && materializedColumnNames.has(p.propertyKey),
    );
    const newProperties = propertyUsage.filter(
      (p) => !existingKeys.has(p.propertyKey) && !materializedColumnNames.has(p.propertyKey),
    );

    const allProperties: PropertyAnalysis[] = [];

    allProperties.push(
      ...alreadyTracked.map((p) => ({
        ...p,
        cardinality: 0,
        estimatedSize: 0,
        benefit: 0,
        skipReason: '✅ Already materialized (tracked)',
      })),
    );

    allProperties.push(
      ...alreadyExistsInClickHouse.map((p) => ({
        ...p,
        cardinality: 0,
        estimatedSize: 0,
        benefit: 0,
        skipReason: `✅ Column already exists in ${targetTable} table`,
      })),
    );

    if (newProperties.length === 0) {
      this.logger.info(`No new ${targetTable} properties to analyze (all already materialized)`);
      return { candidates: [], allProperties };
    }

    this.logger.info(`${newProperties.length} ${targetTable} properties not yet materialized`);

    // Enrich with pain signal. Query-log path (default): one system.query_log
    // scan for the whole batch — no source-table access. Legacy path:
    // per-property probe against events_property_values_mv (events) or the
    // full profiles table (profiles). The legacy profile probe is a
    // full-table scan repeated for every property and was the driver of the
    // hourly CH CPU spike this rewrite is targeting.
    const enrichedStats = this.USE_QUERY_LOG_PAIN_SIGNAL
      ? await this.enrichWithQueryLogStats(newProperties, targetTable)
      : await Promise.all(
          newProperties.map((usage) => this.enrichWithClickHouseStats(usage)),
        );

    // Calculate benefit scores
    const statsWithBenefit = enrichedStats.map((stats) => this.calculateBenefitScore(stats));

    // Determine skip reasons
    const analyzed = statsWithBenefit.map((stats) => ({
      ...stats,
      skipReason: this.getSkipReason(stats, threshold),
    }));

    allProperties.push(...analyzed);

    const candidates = analyzed
      .filter((stat) => !stat.skipReason)
      .map((stats) => this.createCandidate(stats, allColumnNames))
      .sort((a, b) => b.stats.benefit - a.stats.benefit);

    this.logger.info(`Identified ${candidates.length} ${targetTable} candidates for materialization`);

    return {
      candidates,
      allProperties: allProperties.sort((a, b) => b.benefit - a.benefit),
    };
  }

  /**
   * Get every column on the target table, mapped to its default_kind.
   * Used for both "already materialized → skip" detection (default_kind
   * = 'MATERIALIZED') and reserved-column collision detection (everything
   * else: DEFAULT, ALIAS, or no default at all).
   */
  private async getExistingClickHouseColumns(
    targetTable: 'events' | 'profiles',
  ): Promise<Map<string, string>> {
    try {
      const result = await ch.query({
        query: `
          SELECT name, default_kind
          FROM system.columns
          WHERE database = 'default'
            AND table = '${targetTable}'
        `,
        format: 'JSONEachRow',
      });

      const data = await result.json<{ name: string; default_kind: string }>();
      return new Map(data.map((row) => [row.name, row.default_kind]));
    } catch (error) {
      this.logger.warn(`Failed to get existing ClickHouse columns for ${targetTable}`, { error });
      return new Map();
    }
  }

  /**
   * Determine why a property should be skipped.
   *
   * Query-log path (default): skip anything that never showed up in a slow
   * query in the analysis window. If it's not causing pain today, no need
   * to spend a materialized column on it (matches PostHog's philosophy).
   *
   * Legacy path (MATERIALIZE_USE_QUERY_LOG=false): the original
   * cardinality-based checks.
   */
  private getSkipReason(stats: PropertyUsageStats, threshold: number): string | undefined {
    if (stats.usageCount < this.MIN_USAGE_COUNT) {
      return `❌ Low usage (${stats.usageCount} reports, need ${this.MIN_USAGE_COUNT})`;
    }

    if (this.USE_QUERY_LOG_PAIN_SIGNAL) {
      const timeouts = stats.observedTimeouts ?? 0;
      const slowCount = stats.observedSlowCount ?? 0;

      if (timeouts === 0 && slowCount < this.QUERY_LOG_MIN_SLOW_COUNT) {
        return `❌ No pain signal (${timeouts} timeouts, ${slowCount} slow queries in ${this.QUERY_LOG_WINDOW_HOURS}h; need ≥1 timeout OR ≥${this.QUERY_LOG_MIN_SLOW_COUNT} slow)`;
      }
      // No cardinality check — trust the pain signal.
      return undefined;
    }

    if (stats.cardinality === 0) {
      return `❌ No data found in source table`;
    }

    if (stats.cardinality > this.MAX_CARDINALITY) {
      return `❌ Too high cardinality (${stats.cardinality} values > ${this.MAX_CARDINALITY} limit)`;
    }

    if (stats.benefit < threshold) {
      return `❌ Benefit too low (${stats.benefit.toFixed(0)} < ${threshold} threshold)`;
    }

    return undefined;
  }

  /**
   * Extract event properties from reports (properties.*)
   */
  private async getEventsPropertyUsageFromReports(): Promise<
    Array<{
      property: string;
      propertyKey: string;
      targetTable: 'events';
      usageCount: number;
      queryFrequency: number;
    }>
  > {
    const reports = await db.report.findMany({
      select: {
        breakdowns: true,
        events: true,
        globalFilters: true,
        holdProperties: true,
      },
    });

    const propertyMap = new Map<string, number>();

    for (const report of reports) {
      const { eventsProperties } = this.extractPropertiesFromReport(report);
      for (const prop of eventsProperties) {
        propertyMap.set(prop, (propertyMap.get(prop) || 0) + 1);
      }
    }

    const ESTIMATED_QUERIES_PER_DAY = 10;

    return Array.from(propertyMap.entries()).map(([property, usageCount]) => ({
      property,
      propertyKey: property.replace('properties.', ''),
      targetTable: 'events' as const,
      usageCount,
      queryFrequency: usageCount * ESTIMATED_QUERIES_PER_DAY,
    }));
  }

  /**
   * Extract profile properties from reports (profile.properties.*)
   */
  private async getProfilePropertyUsageFromReports(): Promise<
    Array<{
      property: string;
      propertyKey: string;
      targetTable: 'profiles';
      usageCount: number;
      queryFrequency: number;
    }>
  > {
    const reports = await db.report.findMany({
      select: {
        breakdowns: true,
        events: true,
        globalFilters: true,
        holdProperties: true,
      },
    });

    const propertyMap = new Map<string, number>();

    for (const report of reports) {
      const { profileProperties } = this.extractPropertiesFromReport(report);
      for (const prop of profileProperties) {
        propertyMap.set(prop, (propertyMap.get(prop) || 0) + 1);
      }
    }

    const ESTIMATED_QUERIES_PER_DAY = 10;

    return Array.from(propertyMap.entries()).map(([property, usageCount]) => ({
      property,
      // "profile.properties.campaign" -> "campaign"
      propertyKey: property.replace('profile.properties.', ''),
      targetTable: 'profiles' as const,
      usageCount,
      queryFrequency: usageCount * ESTIMATED_QUERIES_PER_DAY,
    }));
  }

  /**
   * Extract property names from report JSON fields
   * Returns two sets: event properties and profile properties
   */
  private extractPropertiesFromReport(report: {
    breakdowns: any;
    events: any;
    globalFilters?: any;
    holdProperties?: any;
  }): { eventsProperties: string[]; profileProperties: string[] } {
    const eventsProperties = new Set<string>();
    const profileProperties = new Set<string>();

    const isValid = (name: string) =>
      !name.includes('*') && !name.includes('(') && !name.includes('[');

    const addProperty = (name: unknown) => {
      if (typeof name !== 'string' || !isValid(name)) return;
      if (name.startsWith('properties.')) {
        eventsProperties.add(name);
      } else if (name.startsWith('profile.properties.')) {
        profileProperties.add(name);
      }
    };

    // Parse breakdowns
    try {
      const breakdowns = Array.isArray(report.breakdowns) ? report.breakdowns : [];
      for (const breakdown of breakdowns) {
        if (breakdown?.name) addProperty(breakdown.name);
      }
    } catch (e) {
      this.logger.warn('Failed to parse breakdowns', { error: e });
    }

    // Parse events (per-series filters)
    try {
      const events = Array.isArray(report.events) ? report.events : [];
      for (const event of events) {
        if (event?.filters && Array.isArray(event.filters)) {
          for (const filter of event.filters) {
            if (filter?.name) addProperty(filter.name);
          }
        }
      }
    } catch (e) {
      this.logger.warn('Failed to parse event filters', { error: e });
    }

    // Parse globalFilters — same shape as per-event filters but stored at
    // the report level. Properties used only via globalFilters (e.g.
    // metadata_type on a funnel that applies it across both steps) were
    // previously invisible to the analyser and never became materialization
    // candidates.
    try {
      const globalFilters = Array.isArray(report.globalFilters) ? report.globalFilters : [];
      for (const filter of globalFilters) {
        if (filter?.name) addProperty(filter.name);
      }
    } catch (e) {
      this.logger.warn('Failed to parse global filters', { error: e });
    }

    // Parse holdProperties — funnel "hold constant" property names stored
    // as a plain string[] on the report. Same materialization win applies
    // when the held property is read from `properties` map on every event.
    try {
      const holdProperties = Array.isArray(report.holdProperties) ? report.holdProperties : [];
      for (const prop of holdProperties) {
        addProperty(prop);
      }
    } catch (e) {
      this.logger.warn('Failed to parse hold properties', { error: e });
    }

    return {
      eventsProperties: Array.from(eventsProperties),
      profileProperties: Array.from(profileProperties),
    };
  }

  /**
   * Enrich a batch of property candidates with pain signal read from
   * `system.query_log` — PostHog-style (see ee/clickhouse/materialized_columns/analyze.py).
   *
   * One CH query, grouped by extracted property name, filtered to slow /
   * timed-out queries on the target table. Returns each input `usage` with
   * `observedOccurrences`, `observedTimeouts`, `observedSlowCount`,
   * `observedTotalMs` attached (all zero for properties with no observed
   * pain). `cardinality` and `estimatedSize` stay zero — the query-log path
   * doesn't need them; `getSkipReason` short-circuits on the pain signal
   * instead of the cardinality cap.
   *
   * Two important filters:
   *   1. `NOT LIKE '%uniqExact(properties[%as cardinality%'` — excludes
   *      this analyzer's own cardinality probes from the legacy path so we
   *      don't chase our own tail if both paths run in the same window.
   *   2. Only queries that actually touched the target table via `tables`
   *      Array — the cheapest way to attribute a property scan to the
   *      right ClickHouse table without regex-guessing.
   *
   * A single scan of ~7d of query_log costs ~130 ms server-side on our
   * cluster (validated 2026-09-02); the legacy per-property profile probe
   * costs ~12s each × N candidates.
   */
  private async enrichWithQueryLogStats(
    usages: Array<{
      property: string;
      propertyKey: string;
      targetTable: 'events' | 'profiles';
      usageCount: number;
      queryFrequency: number;
    }>,
    targetTable: 'events' | 'profiles',
  ): Promise<PropertyUsageStats[]> {
    if (usages.length === 0) return [];

    const painByKey = new Map<
      string,
      {
        occurrences: number;
        timeouts: number;
        slowCount: number;
        totalMs: number;
      }
    >();

    try {
      const result = await ch.query({
        query: `
          WITH
            ${this.QUERY_LOG_SLOW_MS} AS min_query_time_ms,
            (159, 160) AS timeout_codes
          SELECT
            arrayJoin(extractAll(
              query,
              'properties\\\\[\\'([a-zA-Z0-9_\\\\-\\\\.\\\\$]+)\\'\\\\]'
            )) AS prop_name,
            count()                                          AS occurrences,
            countIf(exception_code IN timeout_codes)         AS timeouts,
            countIf(query_duration_ms > min_query_time_ms)   AS slow_count,
            sum(query_duration_ms)                           AS total_ms
          FROM system.query_log
          WHERE event_time > now() - INTERVAL ${this.QUERY_LOG_WINDOW_HOURS} HOUR
            AND type > 1
            AND is_initial_query
            AND query LIKE '%properties[%'
            AND query NOT LIKE '%uniqExact(properties[%'
            AND arrayExists(t -> t = 'default.${targetTable}', tables)
            AND (exception_code IN timeout_codes OR query_duration_ms > min_query_time_ms)
          GROUP BY prop_name
          HAVING timeouts > 0 OR slow_count >= ${this.QUERY_LOG_MIN_SLOW_COUNT}
        `,
        format: 'JSONEachRow',
      });

      const rows = await result.json<{
        prop_name: string;
        occurrences: string;
        timeouts: string;
        slow_count: string;
        total_ms: string;
      }>();

      for (const row of rows) {
        painByKey.set(row.prop_name, {
          occurrences: Number(row.occurrences),
          timeouts: Number(row.timeouts),
          slowCount: Number(row.slow_count),
          totalMs: Number(row.total_ms),
        });
      }

      this.logger.info(
        `Query-log pain signal: ${painByKey.size} ${targetTable} properties over ${this.QUERY_LOG_WINDOW_HOURS}h window`,
      );
    } catch (error) {
      // Fail closed — return zero pain for every property so the run
      // reports "no candidates" instead of falling back to the expensive
      // source-scan path.
      this.logger.warn(
        `Failed to read system.query_log for ${targetTable}; skipping this run`,
        { error },
      );
    }

    return usages.map((usage) => {
      const pain = painByKey.get(usage.propertyKey);
      return {
        property: usage.property,
        propertyKey: usage.propertyKey,
        targetTable: usage.targetTable,
        usageCount: usage.usageCount,
        queryFrequency: usage.queryFrequency,
        cardinality: 0,
        estimatedSize: 0,
        benefit: 0,
        observedOccurrences: pain?.occurrences ?? 0,
        observedTimeouts: pain?.timeouts ?? 0,
        observedSlowCount: pain?.slowCount ?? 0,
        observedTotalMs: pain?.totalMs ?? 0,
      };
    });
  }

  /**
   * Get cardinality and size stats from ClickHouse
   * For events: uses event_property_values_mv
   * For profiles: queries the profiles table directly
   */
  private async enrichWithClickHouseStats(usage: {
    property: string;
    propertyKey: string;
    targetTable: 'events' | 'profiles';
    usageCount: number;
    queryFrequency: number;
  }): Promise<PropertyUsageStats> {
    try {
      let query: string;

      if (usage.targetTable === 'profiles') {
        // Query the profiles table directly for profile properties
        query = `
          SELECT
            uniqExact(properties['${usage.propertyKey}']) AS cardinality,
            avg(length(properties['${usage.propertyKey}'])) AS avg_length,
            count() AS total_occurrences
          FROM profiles
          WHERE properties['${usage.propertyKey}'] != ''
        `;
      } else {
        // Use the materialized view for event properties (much faster)
        query = `
          SELECT
            uniqExact(property_value) AS cardinality,
            avg(length(property_value)) AS avg_length,
            count() AS total_occurrences
          FROM event_property_values_mv
          WHERE property_key = '${usage.propertyKey}'
            AND property_value != ''
        `;
      }

      const result = await ch.query({ query, format: 'JSONEachRow' });

      const data = await result.json<{
        cardinality: string;
        avg_length: string;
        total_occurrences: string;
      }>();

      const cardinality = Number(data[0]?.cardinality || 0);
      const avgLength = Number(data[0]?.avg_length || 10);
      const totalOccurrences = Number(data[0]?.total_occurrences || 0);
      const estimatedSize = Math.ceil(avgLength * totalOccurrences);

      return {
        property: usage.property,
        propertyKey: usage.propertyKey,
        targetTable: usage.targetTable,
        usageCount: usage.usageCount,
        queryFrequency: usage.queryFrequency,
        cardinality,
        estimatedSize,
        benefit: 0,
      };
    } catch (error) {
      this.logger.warn(`Failed to get stats for ${usage.property}`, { error });
      return {
        property: usage.property,
        propertyKey: usage.propertyKey,
        targetTable: usage.targetTable,
        usageCount: usage.usageCount,
        queryFrequency: usage.queryFrequency,
        cardinality: 0,
        estimatedSize: 0,
        benefit: 0,
      };
    }
  }

  /**
   * Calculate benefit score.
   *
   * Query-log path (default): benefit = timeouts × 1000 + slowCount × 10 +
   * occurrences. Weights match PostHog's ORDER BY (timeouts dominate a
   * single slow-count run; slow_count dominates raw occurrences). Ensures
   * a property that timed out once ranks above 100 slow-but-completed
   * queries, which matches operator intuition.
   *
   * Legacy path: original usage/frequency vs cardinality/size formula.
   */
  private calculateBenefitScore(stats: PropertyUsageStats): PropertyUsageStats {
    if (this.USE_QUERY_LOG_PAIN_SIGNAL) {
      const timeouts = stats.observedTimeouts ?? 0;
      const slowCount = stats.observedSlowCount ?? 0;
      const occurrences = stats.observedOccurrences ?? 0;
      const benefit = timeouts * 1000 + slowCount * 10 + occurrences;
      return { ...stats, benefit };
    }

    const usageScore = stats.usageCount * 10;
    const frequencyScore = Math.min(stats.queryFrequency, 1000);
    const cardinalityPenalty = Math.max(0, stats.cardinality - 100) * 0.5;
    const sizePenalty = stats.estimatedSize / 1_000_000;

    const benefit = usageScore + frequencyScore - cardinalityPenalty - sizePenalty;

    return { ...stats, benefit: Math.max(0, benefit) };
  }

  /**
   * Create candidate object.
   *
   * If `propertyKey` collides with a column that already exists on the target
   * table (regular column, DEFAULT, or ALIAS — NOT another MATERIALIZED
   * projection, which would have been skipped upstream), we prefix the
   * column name with `prop_`. Without this rename, `ALTER TABLE ... ADD COLUMN
   * IF NOT EXISTS` becomes a silent no-op and the Postgres tracking row
   * misleads the chart engine into rewriting `properties.<key>` to the wrong
   * (existing) column — e.g. `properties.name` → the event-name column.
   */
  private createCandidate(
    stats: PropertyUsageStats,
    reservedColumnNames: Set<string>,
  ): MaterializedColumnCandidate {
    const collides = reservedColumnNames.has(stats.propertyKey);
    const columnName = collides ? `prop_${stats.propertyKey}` : stats.propertyKey;

    let reason: string;
    if (this.USE_QUERY_LOG_PAIN_SIGNAL) {
      const timeouts = stats.observedTimeouts ?? 0;
      const slowCount = stats.observedSlowCount ?? 0;
      const occurrences = stats.observedOccurrences ?? 0;
      const totalMs = stats.observedTotalMs ?? 0;
      reason =
        `Slow-query pain over ${this.QUERY_LOG_WINDOW_HOURS}h: ` +
        `${timeouts} timeouts, ${slowCount} slow queries, ${occurrences} total observations, ` +
        `${(totalMs / 1000).toFixed(1)}s CH time. ` +
        `Also referenced by ${stats.usageCount} report(s). `;
    } else {
      reason = `Used in ${stats.usageCount} reports (~${stats.queryFrequency} queries/day). `;

      if (stats.cardinality < 50) {
        reason += 'Low cardinality (ideal). ';
      } else if (stats.cardinality < 200) {
        reason += 'Moderate cardinality. ';
      }

      if (stats.estimatedSize < 100_000_000) {
        reason += 'Small storage cost. ';
      }
    }

    if (collides) {
      reason += `Renamed to \`${columnName}\` (collides with existing ${stats.targetTable}.${stats.propertyKey} column). `;
    }

    reason += `Benefit: ${stats.benefit.toFixed(0)}.`;

    return {
      propertyKey: stats.propertyKey,
      columnName,
      targetTable: stats.targetTable,
      reason,
      stats,
    };
  }

  /**
   * Execute materialization on the appropriate table
   */
  private async materializeColumn(candidate: MaterializedColumnCandidate): Promise<void> {
    const table = candidate.targetTable;

    this.logger.info(`Materializing column: ${table}.${candidate.columnName}`, {
      reason: candidate.reason,
    });

    try {
      // Execute ALTER TABLE on the target table
      // Backtick-quote the column name to support keys with hyphens or other special chars
      await chMigrationClient.command({
        query: `
          ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS \`${candidate.columnName}\` String
          MATERIALIZED properties['${candidate.propertyKey}']
        `,
      });

      // Record in database with targetTable
      await db.materializedColumn.create({
        data: {
          targetTable: candidate.targetTable,
          propertyKey: candidate.propertyKey,
          columnName: candidate.columnName,
          cardinality: candidate.stats.cardinality,
          usageCount: candidate.stats.usageCount,
          benefitScore: candidate.stats.benefit,
          estimatedSize: BigInt(candidate.stats.estimatedSize),
          status: 'active',
          materializedAt: new Date(),
        },
      });

      // Refresh chart service cache so new column is used immediately
      await refreshMaterializedColumnsCache();

      this.logger.info(`Successfully materialized: ${table}.${candidate.columnName}`);
    } catch (error) {
      try {
        await db.materializedColumn.create({
          data: {
            targetTable: candidate.targetTable,
            propertyKey: candidate.propertyKey,
            columnName: candidate.columnName,
            cardinality: candidate.stats.cardinality,
            usageCount: candidate.stats.usageCount,
            benefitScore: candidate.stats.benefit,
            estimatedSize: BigInt(candidate.stats.estimatedSize),
            status: 'failed',
          },
        });
      } catch (dbError) {
        this.logger.error('Failed to record failure in database', { dbError });
      }

      throw error;
    }
  }

  /**
   * Generate human-readable report
   */
  private generateReport(
    candidates: MaterializedColumnCandidate[],
    allProperties: PropertyAnalysis[],
    dryRun: boolean,
  ): string {
    let report = '\n' + '='.repeat(80) + '\n';
    report += dryRun
      ? 'DRY RUN: Materialized Column Analysis\n'
      : 'Materialized Column Analysis\n';
    report += '='.repeat(80) + '\n\n';

    report += `Total properties analyzed: ${allProperties.length}\n`;
    report += `Candidates for materialization: ${candidates.length}\n\n`;

    if (candidates.length > 0) {
      report += '━'.repeat(80) + '\n';
      report += '✅ RECOMMENDED FOR MATERIALIZATION\n';
      report += '━'.repeat(80) + '\n\n';

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]!;
        const prefix = candidate.targetTable === 'profiles' ? 'profile.properties' : 'properties';
        report += `${i + 1}. ${prefix}.${candidate.propertyKey} [${candidate.targetTable}]\n`;
        report += `   Usage: ${candidate.stats.usageCount} reports, ~${candidate.stats.queryFrequency} queries/day\n`;
        report += `   Cardinality: ${candidate.stats.cardinality} unique values\n`;
        report += `   Storage: ~${(candidate.stats.estimatedSize / 1_000_000).toFixed(2)} MB\n`;
        report += `   Benefit Score: ${candidate.stats.benefit.toFixed(2)}\n`;
        report += `   Reason: ${candidate.reason}\n\n`;
      }
    }

    const skipped = allProperties.filter((p) => p.skipReason);
    if (skipped.length > 0) {
      report += '━'.repeat(80) + '\n';
      report += 'ALL PROPERTIES ANALYZED\n';
      report += '━'.repeat(80) + '\n\n';

      for (const prop of skipped) {
        const prefix = prop.targetTable === 'profiles' ? 'profile.properties' : 'properties';
        report += `• ${prefix}.${prop.propertyKey} [${prop.targetTable}]\n`;
        report += `  ${prop.skipReason}\n`;
        report += `  Usage: ${prop.usageCount} reports, ~${prop.queryFrequency} queries/day`;
        if (prop.cardinality > 0) {
          report += `, Cardinality: ${prop.cardinality}, Benefit: ${prop.benefit.toFixed(0)}`;
        }
        report += '\n\n';
      }
    }

    report += '━'.repeat(80) + '\n';
    report += 'SUMMARY\n';
    report += '━'.repeat(80) + '\n';

    if (dryRun) {
      report += '⚠️  DRY RUN MODE: No changes will be made.\n';
      report += 'Run with --execute flag to materialize these columns.\n';
    } else if (candidates.length > 0) {
      report += `✅ Materializing top ${Math.min(candidates.length, this.MAX_DAILY_MATERIALIZATIONS)} columns...\n`;
    } else {
      report += 'No actions needed. All eligible properties are already materialized.\n';
    }

    report += '\n' + '='.repeat(80) + '\n';

    return report;
  }
}

export const materializeColumnsService = new MaterializeColumnsService();
