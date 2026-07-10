import {
  chMigrationClient,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

/**
 * Backfill `profile_event_property_summary_v2` via the Null-engine staging pattern.
 *
 * Why: the previous chunked `INSERT INTO v2 SELECT ... FROM events GROUP BY ...`
 * approach forced ClickHouse to load the entire per-chunk aggregation state into
 * RAM at merge time, hitting Aiven's ~23 GiB per-query cap on 6h afternoon
 * chunks and causing MEMORY_LIMIT_EXCEEDED. Cutting to 3h chunks fixed memory
 * but still peaked CPU at 77%. Root cause is architectural, not per-chunk size:
 * one big aggregation always accumulates state in memory.
 *
 * Fix (per ClickHouse official docs `data-modeling/backfilling`): route source
 * events through a `Null`-engine staging table with a chained MV. The MV
 * processes events BLOCK-BY-BLOCK (~1M rows per block) — each block gets its
 * own bounded aggregation, and AggregatingMergeTree merges the partial states
 * in the background. Peak memory becomes ~200 MB per block regardless of total
 * scan size. Null-engine discards blocks after the MV consumes them, so zero
 * storage cost for the staging path.
 *
 * Live writer safety: the live `_v2_mv` is bound to `events` (source). The
 * backfill MV is bound to `events_backfill_null` (different source). Same v2
 * target, different write paths — no double-fire on any single INSERT.
 *
 * Setup is idempotent (`CREATE ... IF NOT EXISTS`) so the same call can be
 * fired repeatedly to advance one day at a time. Manual cleanup at the end:
 *   DROP TABLE default.profile_event_property_summary_v2_backfill_mv ON CLUSTER default SYNC;
 *   DROP TABLE default.events_backfill_null ON CLUSTER default SYNC;
 *
 * Usage:
 *   Dry-run one day:
 *     pnpm migrate:deploy:code -- 22 --cluster --dry \
 *       --start="2026-07-05 00:00:00" --end="2026-07-06 00:00:00" --no-record
 *   Execute one day:
 *     pnpm migrate:deploy:code -- 22 --cluster \
 *       --start="2026-07-05 00:00:00" --end="2026-07-06 00:00:00" --no-record
 *
 * Loop by day via the k8s Job at
 * openpanel/backfill-profile-event-property-summary-mv-v2.yaml
 */

const V2_TABLE = 'profile_event_property_summary_v2';
const NULL_TABLE = 'events_backfill_null';
const BACKFILL_MV = 'profile_event_property_summary_v2_backfill_mv';

function parseArgs() {
  const args = process.argv;
  const startArg = args.find((a: string) => a.startsWith('--start='));
  const endArg = args.find((a: string) => a.startsWith('--end='));

  const start = startArg ? startArg.split('=')[1]! : null;
  const end = endArg ? endArg.split('=')[1]! : null;

  return {
    start,
    end,
    isCluster: getIsCluster(),
    isDry: args.includes('--dry'),
  };
}

async function ensureSetup(isCluster: boolean): Promise<void> {
  const onCluster = isCluster ? 'ON CLUSTER default' : '';

  // Null-engine staging: same schema as events (via `AS default.events`), discards
  // rows on INSERT, chained MV consumes them first. Zero storage.
  const nullTableSql = `
    CREATE TABLE IF NOT EXISTS default.${NULL_TABLE} ${onCluster}
    AS default.events
    ENGINE = Null`;

  // Backfill MV: same SELECT as the live _v2_mv, but source = Null table.
  // Same v2 target, so partial states from live + backfill are merged by the
  // AggregatingMergeTree background merge scheduler.
  const backfillMvSql = `
    CREATE MATERIALIZED VIEW IF NOT EXISTS default.${BACKFILL_MV} ${onCluster}
    TO default.${V2_TABLE}
    AS SELECT
        project_id,
        profile_id,
        name,
        property_key,
        property_value,
        toStartOfDay(created_at) AS event_date,
        countState() AS event_count,
        minState(created_at) AS first_event_time,
        maxState(created_at) AS last_event_time
    FROM default.${NULL_TABLE}
    ARRAY JOIN
        mapKeys(properties) AS property_key,
        mapValues(properties) AS property_value
    WHERE property_key != '' AND property_value != ''
    GROUP BY project_id, profile_id, name, property_key, property_value, event_date`;

  await runClickhouseMigrationCommands([nullTableSql, backfillMvSql]);
}

export async function up() {
  const { start, end, isCluster, isDry } = parseArgs();

  // Manual per-window migration. No-op if the auto migrate:deploy loop imports
  // it during deploy so it never crashes CI.
  if (!start || !end) {
    console.log(
      '[22-null-backfill] No --start/--end provided — manual per-window migration, skipping.',
    );
    console.log(
      '   Run via: pnpm migrate:deploy:code -- 22 --cluster \\',
    );
    console.log(
      '     --start="2026-07-05 00:00:00" --end="2026-07-06 00:00:00" --no-record',
    );
    return;
  }

  console.log('='.repeat(60));
  console.log(`  BACKFILL ${V2_TABLE} (via Null-engine staging)`);
  console.log(`  From: ${start}`);
  console.log(`  To:   ${end}`);
  console.log(`  Mode: ${isDry ? 'DRY RUN' : 'EXECUTE'}`);
  console.log('='.repeat(60));

  // Source count sanity check
  console.log(`\n[Step 0] Source events in [${start}, ${end}):`);
  const srcResult = await chMigrationClient.query({
    query: `
      SELECT count() AS total
      FROM default.events
      WHERE created_at >= toDateTime('${start}')
        AND created_at < toDateTime('${end}')`,
    format: 'JSONEachRow',
  });
  const srcTotal = Number(
    (await srcResult.json<{ total: string }>())[0]?.total ?? 0,
  );
  console.log(`  Raw events: ${srcTotal.toLocaleString()}`);

  if (srcTotal === 0) {
    console.log('\n  Nothing to backfill for this window.');
    return;
  }

  // Ensure Null-engine staging + backfill MV are in place (idempotent)
  console.log(`\n[Step 1] Ensuring Null-engine staging + backfill MV exist...`);
  await ensureSetup(isCluster);
  console.log('  OK');

  // The actual backfill: block-by-block via the Null-engine pipeline.
  //   - Blocks of ~1M rows / ~10 MiB flow through the Null table
  //   - Backfill MV aggregates each block into partial states → v2
  //   - Peak memory: ~200 MB per block (not per-window), way under Aiven's cap
  //   - `optimize_trivial_insert_select=1` aligns SELECT parallelism with insert
  //   - `max_threads=4` and `max_insert_threads=4` keep CPU under ~40-50%
  const insertSql = `
    INSERT INTO default.${NULL_TABLE}
    SELECT * FROM default.events
    WHERE created_at >= toDateTime('${start}')
      AND created_at <  toDateTime('${end}')
    SETTINGS
      max_insert_threads = 4,
      max_threads = 4,
      min_insert_block_size_bytes_for_materialized_views = 10485760,
      min_insert_block_size_rows_for_materialized_views = 1000000,
      optimize_trivial_insert_select = 1,
      max_execution_time = 7200`;

  if (isDry) {
    console.log('\n[DRY RUN] SQL that would execute:');
    console.log(insertSql);
    return;
  }

  console.log(
    `\n[Step 2] Running INSERT (block-by-block via Null pipeline)...`,
  );
  const startTime = Date.now();
  await runClickhouseMigrationCommands([insertSql]);
  const elapsedSec = Math.round((Date.now() - startTime) / 1000);
  console.log(
    `  Done in ${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`,
  );

  console.log('\n' + '='.repeat(60));
  console.log('  WINDOW COMPLETE');
  console.log('='.repeat(60));
}

export async function down() {
  console.log('No down migration');
}
