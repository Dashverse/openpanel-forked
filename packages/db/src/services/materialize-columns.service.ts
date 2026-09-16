import { type ILogger, createLogger } from '@openpanel/logger';
import { db } from '../../index';
import { ch } from '../clickhouse/client';
import { chMigrationClient } from '../clickhouse/migration';
import { refreshMaterializedColumnsCache } from './chart.service';

// Pain signal for one property, read from system.query_log.
interface PropertyPain {
  occurrences: number; // total slow/timed-out queries touching this property
  timeouts: number; // queries that hit the CH execution-time limit
  slowCount: number; // queries slower than QUERY_LOG_SLOW_MS
  totalMs: number; // summed query_duration_ms
}

interface PropertyStats extends PropertyPain {
  property: string; // Full path: "properties.utm_source" / "profile.properties.campaign"
  propertyKey: string; // Key only: "utm_source" / "campaign"
  targetTable: 'events' | 'profiles';
  benefit: number; // Ranking score derived from the pain signal
}

interface PropertyAnalysis extends PropertyStats {
  skipReason?: string; // Why it wasn't materialized (if skipped)
}

interface MaterializedColumnCandidate {
  propertyKey: string;
  columnName: string;
  targetTable: 'events' | 'profiles';
  reason: string;
  stats: PropertyStats;
}

/**
 * Picks ClickHouse map properties worth promoting to real materialized columns,
 * driven purely by observed pain in `system.query_log` (PostHog's approach, see
 * ee/clickhouse/materialized_columns/analyze.py).
 *
 * A property becomes a candidate when queries reading `properties['<key>']` on
 * the target table are timing out or running slow in the analysis window. This
 * catches the real offenders regardless of whether any saved report references
 * them (dashboard filters, breakdowns, ad-hoc / API queries) — the thing that
 * hurts is the thing that gets fixed.
 */
export class MaterializeColumnsService {
  private logger: ILogger;

  private readonly MIN_BENEFIT_SCORE = 20; // Default benefit floor to materialize
  private readonly MAX_DAILY_MATERIALIZATIONS = 3; // Max new columns per run (both tables)

  // query_log analysis knobs — env-tunable for scale without a redeploy.
  private readonly WINDOW_HOURS = Number.parseInt(
    process.env.MATERIALIZE_QUERY_LOG_WINDOW_HOURS || '168', // 7 days
    10,
  );
  private readonly SLOW_MS = Number.parseInt(
    process.env.MATERIALIZE_QUERY_LOG_SLOW_MS || '2000', // 2s
    10,
  );
  private readonly MIN_SLOW_COUNT = Number.parseInt(
    process.env.MATERIALIZE_QUERY_LOG_MIN_SLOW_COUNT || '3',
    10,
  );

  // Clustered deployments must aggregate query_log across replicas (it's
  // node-local); set MATERIALIZE_QUERY_LOG_CLUSTER to the cluster name (our
  // prod uses "default"). Left empty for single-node / self-hosted setups that
  // have no cluster configured — there we read system.query_log directly, since
  // clusterAllReplicas('default', …) would error on an undefined cluster.
  // Sanitized to an identifier to keep it out of the raw SQL string safely.
  private readonly QUERY_LOG_CLUSTER = (
    process.env.MATERIALIZE_QUERY_LOG_CLUSTER || ''
  ).replace(/[^A-Za-z0-9_]/g, '');

  constructor() {
    this.logger = createLogger({ name: 'materialize-columns' });
  }

  /**
   * Analyze both tables and (unless dryRun) materialize the top candidates.
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

    // Events only. The pain signal is `properties['x']` map reads, which in
    // generated SQL come exclusively from the events table — profile
    // properties render as `profile.`properties.X`` (an aliased join column),
    // so they never match this pattern. Running a "profiles" pass over the
    // same regex would only misattribute events properties that leaked in via
    // mixed-table queries (an events filter + a profile filter log both
    // tables), never find real profile pain. Profiles are also a fraction of
    // the events volume, so map-read cost there is negligible.
    const { candidates, allProperties } = await this.analyzeTable(
      'events',
      threshold,
    );
    const report = this.generateReport(candidates, allProperties, dryRun);

    const materialized: string[] = [];
    if (!dryRun && candidates.length > 0) {
      const limited = candidates.slice(0, this.MAX_DAILY_MATERIALIZATIONS);
      if (limited.length < candidates.length) {
        this.logger.warn(
          `Rate limiting: materializing ${limited.length} of ${candidates.length} candidates`,
        );
      }
      for (const candidate of limited) {
        try {
          await this.materializeColumn(candidate);
          materialized.push(
            `${candidate.targetTable}:${candidate.propertyKey}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to materialize ${candidate.targetTable}:${candidate.propertyKey}`,
            { error },
          );
        }
      }
    }

    return { candidates, allProperties, report, materialized };
  }

  /**
   * Analyze one table: read the pain signal, drop anything already
   * materialized, score + rank the rest.
   */
  private async analyzeTable(
    targetTable: 'events' | 'profiles',
    threshold: number,
  ): Promise<{
    candidates: MaterializedColumnCandidate[];
    allProperties: PropertyAnalysis[];
  }> {
    const painByKey = await this.fetchQueryLogPain(targetTable);
    if (painByKey.size === 0) {
      this.logger.info(
        `No ${targetTable} properties with slow-query pain in ${this.WINDOW_HOURS}h`,
      );
      return { candidates: [], allProperties: [] };
    }
    this.logger.info(
      `${painByKey.size} ${targetTable} properties showing slow-query pain`,
    );

    // What's already a column? `tracked` = we materialized it before;
    // `materialized` = a MATERIALIZED column exists; `reserved` = any column
    // name (used to rename on collision with a real column like `name`).
    const tracked = new Set(
      (
        await db.materializedColumn.findMany({
          where: { status: 'active', targetTable },
          select: { propertyKey: true },
        })
      ).map((c) => c.propertyKey),
    );
    const columns = await this.getExistingClickHouseColumns(targetTable);
    const materialized = new Set(
      Array.from(columns.entries())
        .filter(([, kind]) => kind === 'MATERIALIZED')
        .map(([name]) => name),
    );
    const reserved = new Set(columns.keys());

    const allProperties: PropertyAnalysis[] = [];
    const eligible: PropertyAnalysis[] = [];

    for (const [key, pain] of painByKey) {
      const stats: PropertyStats = {
        property:
          targetTable === 'events'
            ? `properties.${key}`
            : `profile.properties.${key}`,
        propertyKey: key,
        targetTable,
        ...pain,
        benefit: this.benefitScore(pain),
      };

      let skipReason: string | undefined;
      if (tracked.has(key)) {
        skipReason = '✅ Already materialized (tracked)';
      } else if (materialized.has(key)) {
        skipReason = `✅ Column already exists in ${targetTable} table`;
      } else if (stats.benefit < threshold) {
        skipReason = `❌ Benefit ${stats.benefit} < ${threshold} threshold`;
      }

      const analysis = { ...stats, skipReason };
      allProperties.push(analysis);
      if (!skipReason) eligible.push(analysis);
    }

    const candidates = eligible
      .map((stats) => this.createCandidate(stats, reserved))
      .sort((a, b) => b.stats.benefit - a.stats.benefit);

    this.logger.info(
      `Identified ${candidates.length} ${targetTable} candidates`,
    );
    return {
      candidates,
      allProperties: allProperties.sort((a, b) => b.benefit - a.benefit),
    };
  }

  /**
   * Read the pain signal from system.query_log: for each property read via
   * `properties['<key>']` on the target table, how many slow / timed-out
   * queries touched it in the window. One grouped scan; ~130ms server-side, no
   * source-table access. query_log is node-local, so on a clustered deployment
   * (QUERY_LOG_CLUSTER set) this reads clusterAllReplicas to see every replica;
   * on single-node setups it reads system.query_log directly.
   *
   * Returns only properties clearing the pain bar (≥1 timeout OR
   * ≥MIN_SLOW_COUNT slow queries). Fails closed: on error, an empty map, so
   * the run reports "no candidates" rather than doing anything risky.
   */
  private async fetchQueryLogPain(
    targetTable: 'events' | 'profiles',
  ): Promise<Map<string, PropertyPain>> {
    const painByKey = new Map<string, PropertyPain>();
    try {
      const result = await ch.query({
        query: `
          WITH
            ${this.SLOW_MS} AS min_query_time_ms,
            (159, 160) AS timeout_codes
          SELECT
            -- arrayDistinct: a single query can reference properties['x']
            -- more than once (e.g. SELECT + WHERE); without it arrayJoin would
            -- count that one query multiple times and inflate the pain signal
            -- (a lone slow query could spuriously clear MIN_SLOW_COUNT).
            arrayJoin(arrayDistinct(extractAll(
              query,
              'properties\\\\[\\'([a-zA-Z0-9_\\\\-\\\\.\\\\$]+)\\'\\\\]'
            ))) AS prop_name,
            count()                                          AS occurrences,
            countIf(exception_code IN timeout_codes)         AS timeouts,
            countIf(query_duration_ms > min_query_time_ms)   AS slow_count,
            sum(query_duration_ms)                           AS total_ms
          FROM ${
            this.QUERY_LOG_CLUSTER
              ? `clusterAllReplicas('${this.QUERY_LOG_CLUSTER}', system.query_log)`
              : 'system.query_log'
          }
          WHERE event_time > now() - INTERVAL ${this.WINDOW_HOURS} HOUR
            AND type > 1
            AND is_initial_query
            AND query LIKE '%properties[%'
            AND query NOT LIKE '%uniqExact(properties[%'
            AND arrayExists(t -> t = 'default.${targetTable}', tables)
            AND (exception_code IN timeout_codes OR query_duration_ms > min_query_time_ms)
          GROUP BY prop_name
          HAVING timeouts > 0 OR slow_count >= ${this.MIN_SLOW_COUNT}
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
    } catch (error) {
      this.logger.warn(
        `Failed to read system.query_log for ${targetTable}; skipping`,
        {
          error,
        },
      );
    }
    return painByKey;
  }

  /**
   * Every column on the target table → its default_kind. Used to detect
   * "already materialized" (kind === 'MATERIALIZED') and name collisions with
   * real columns (everything else).
   */
  private async getExistingClickHouseColumns(
    targetTable: 'events' | 'profiles',
  ): Promise<Map<string, string>> {
    try {
      const result = await ch.query({
        query: `
          SELECT name, default_kind
          FROM system.columns
          WHERE database = 'default' AND table = '${targetTable}'
        `,
        format: 'JSONEachRow',
      });
      const data = await result.json<{ name: string; default_kind: string }>();
      return new Map(data.map((row) => [row.name, row.default_kind]));
    } catch (error) {
      this.logger.warn(`Failed to get existing columns for ${targetTable}`, {
        error,
      });
      return new Map();
    }
  }

  /**
   * Rank by pain: a timeout dominates a merely-slow query, which dominates a
   * raw occurrence — so one timeout outranks 100 slow-but-completed queries.
   */
  private benefitScore(pain: PropertyPain): number {
    return pain.timeouts * 1000 + pain.slowCount * 10 + pain.occurrences;
  }

  /**
   * Build a candidate. If the property key collides with an existing column
   * (a real column, DEFAULT, or ALIAS — not a MATERIALIZED one, which was
   * skipped upstream), prefix with `prop_`: otherwise `ADD COLUMN IF NOT
   * EXISTS` silently no-ops and the tracking row would point the chart engine
   * at the wrong column (e.g. `properties.name` → the event-name column).
   */
  private createCandidate(
    stats: PropertyStats,
    reservedColumnNames: Set<string>,
  ): MaterializedColumnCandidate {
    const collides = reservedColumnNames.has(stats.propertyKey);
    const columnName = collides
      ? `prop_${stats.propertyKey}`
      : stats.propertyKey;

    let reason =
      `${stats.timeouts} timeouts, ${stats.slowCount} slow queries, ` +
      `${(stats.totalMs / 1000).toFixed(1)}s CH time over ${this.WINDOW_HOURS}h. `;
    if (collides) {
      reason += `Renamed to \`${columnName}\` (collides with existing ${stats.targetTable}.${stats.propertyKey} column). `;
    }
    reason += `Benefit: ${stats.benefit}.`;

    return {
      propertyKey: stats.propertyKey,
      columnName,
      targetTable: stats.targetTable,
      reason,
      stats,
    };
  }

  /**
   * Run the ALTER TABLE and record it. Backtick-quote the column name to
   * support keys with hyphens / special chars.
   */
  private async materializeColumn(
    candidate: MaterializedColumnCandidate,
  ): Promise<void> {
    const { targetTable, columnName, propertyKey, stats } = candidate;
    this.logger.info(`Materializing column: ${targetTable}.${columnName}`, {
      reason: candidate.reason,
    });

    try {
      await chMigrationClient.command({
        query: `
          ALTER TABLE ${targetTable}
          ADD COLUMN IF NOT EXISTS \`${columnName}\` String
          MATERIALIZED properties['${propertyKey}']
        `,
      });

      await db.materializedColumn.create({
        data: {
          targetTable,
          propertyKey,
          columnName,
          cardinality: 0,
          usageCount: 0,
          benefitScore: stats.benefit,
          estimatedSize: BigInt(0),
          status: 'active',
          materializedAt: new Date(),
        },
      });

      // Refresh chart-service cache so the new column is used immediately.
      await refreshMaterializedColumnsCache();
      this.logger.info(
        `Successfully materialized: ${targetTable}.${columnName}`,
      );
    } catch (error) {
      try {
        await db.materializedColumn.create({
          data: {
            targetTable,
            propertyKey,
            columnName,
            cardinality: 0,
            usageCount: 0,
            benefitScore: stats.benefit,
            estimatedSize: BigInt(0),
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
   * Human-readable report.
   */
  private generateReport(
    candidates: MaterializedColumnCandidate[],
    allProperties: PropertyAnalysis[],
    dryRun: boolean,
  ): string {
    const rule = '━'.repeat(80);
    let report = `\n${'='.repeat(80)}\n`;
    report += `${dryRun ? 'DRY RUN: ' : ''}Materialized Column Analysis\n`;
    report += `${'='.repeat(80)}\n\n`;
    report += `Properties with pain: ${allProperties.length}\n`;
    report += `Candidates for materialization: ${candidates.length}\n\n`;

    if (candidates.length > 0) {
      report += `${rule}\n✅ RECOMMENDED FOR MATERIALIZATION\n${rule}\n\n`;
      candidates.forEach((candidate, i) => {
        const { targetTable, propertyKey, stats } = candidate;
        report += `${i + 1}. ${stats.property} [${targetTable}]\n`;
        report += `   ${stats.timeouts} timeouts, ${stats.slowCount} slow, ${(stats.totalMs / 1000).toFixed(1)}s CH time — benefit ${stats.benefit}\n`;
        report += `   ${candidate.reason}\n\n`;
      });
    }

    const skipped = allProperties.filter((p) => p.skipReason);
    if (skipped.length > 0) {
      report += `${rule}\nSKIPPED\n${rule}\n\n`;
      for (const prop of skipped) {
        report += `• ${prop.property} [${prop.targetTable}]\n`;
        report += `  ${prop.skipReason} (${prop.timeouts} timeouts, ${prop.slowCount} slow)\n\n`;
      }
    }

    report += `${rule}\nSUMMARY\n${rule}\n`;
    if (dryRun) {
      report +=
        '⚠️  DRY RUN: no changes made. Run with --execute to materialize.\n';
    } else if (candidates.length > 0) {
      report += `✅ Materializing top ${Math.min(candidates.length, this.MAX_DAILY_MATERIALIZATIONS)} column(s).\n`;
    } else {
      report += 'No actions needed.\n';
    }
    report += `\n${'='.repeat(80)}\n`;
    return report;
  }
}

export const materializeColumnsService = new MaterializeColumnsService();
