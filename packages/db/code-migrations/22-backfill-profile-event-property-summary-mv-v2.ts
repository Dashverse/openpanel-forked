import {
  chMigrationClient,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

/**
 * Backfill `profile_event_property_summary_v2` from `events`, one chunk at a time.
 *
 * v2 is the anonymous-inclusive rebuild of `profile_event_property_summary_mv`
 * — same schema minus the `WHERE profile_id != device_id` filter at the ARRAY JOIN.
 * See `/Users/dhruvsharma/.claude/plans/hazy-churning-parrot.md` for the full context.
 *
 * v2 target table + MV writer live on prod since 2026-07-10 08:53:40 UTC (via
 * `openpanel/drop-and-recreate-property-mv-v2.sql`). Live writer captures new
 * INSERTs from that moment onward; this migration backfills history before it.
 *
 * Chunk = a time window. 6-hour chunks are the sweet spot for the current cluster
 * size (Aiven 32-CPU, 3-replica): each chunk runs at max_threads=8 (25% of one
 * node), external group by spills to disk at 4 GiB, stays under Aiven's ~28 GiB
 * per-query memory cap. Reference: 6h chunk ≈ 13-15 min wall-clock.
 *
 * Usage:
 *   Dry-run one chunk:
 *     pnpm migrate:deploy:code -- 21 --cluster --dry \
 *       --start="2026-07-08 06:00:00" --end="2026-07-08 12:00:00" --no-record
 *
 *   Execute one chunk:
 *     pnpm migrate:deploy:code -- 21 --cluster \
 *       --start="2026-07-08 06:00:00" --end="2026-07-08 12:00:00" --no-record
 *
 * Loop multiple chunks via a k8s Job — see
 * openpanel/backfill-profile-event-property-summary-mv-v2.yaml
 *
 * Idempotency: this migration does NOT guard against double-runs. Re-running the
 * same window doubles the countState() aggregate for the affected keys. Verify
 * once at the end via events-vs-v2 event_count comparison; if inflated, DROP
 * PARTITION 'YYYYMM' on v2 and re-backfill that month.
 */

const V2_TABLE = 'profile_event_property_summary_v2';

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

export async function up() {
  const { start, end, isDry } = parseArgs();

  // Manual per-chunk migration. If run without --start/--end (e.g. the automatic
  // migrate:deploy loop imports it during deploy), no-op so it never crashes.
  if (!start || !end) {
    console.log(
      '[21-backfill-v2] No --start/--end provided — manual per-chunk migration, skipping.',
    );
    console.log(
      '   Run via: pnpm migrate:deploy:code -- 21 --cluster \\',
    );
    console.log(
      '     --start="2026-07-08 06:00:00" --end="2026-07-08 12:00:00" --no-record',
    );
    return;
  }

  console.log('='.repeat(60));
  console.log(`  BACKFILL ${V2_TABLE}`);
  console.log(`  From: ${start}`);
  console.log(`  To:   ${end}`);
  console.log(`  Mode: ${isDry ? 'DRY RUN' : 'EXECUTE'}`);
  console.log('='.repeat(60));

  // Step 0: source event count for the window (sanity)
  console.log(`\n[Step 0] Source events in [${start}, ${end}):`);
  const srcResult = await chMigrationClient.query({
    query: `
      SELECT count() AS total
      FROM events
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

  const insertSql = `
    INSERT INTO ${V2_TABLE}
    SELECT
        project_id,
        profile_id,
        name,
        property_key,
        property_value,
        toStartOfDay(created_at) AS event_date,
        countState() AS event_count,
        minState(created_at) AS first_event_time,
        maxState(created_at) AS last_event_time
    FROM events
    ARRAY JOIN
        mapKeys(properties) AS property_key,
        mapValues(properties) AS property_value
    WHERE
        created_at >= toDateTime('${start}')
        AND created_at < toDateTime('${end}')
        AND property_key != ''
        AND property_value != ''
    GROUP BY
        project_id, profile_id, name, property_key, property_value, event_date
    SETTINGS
        max_threads = 8,
        max_memory_usage = 25000000000,
        max_bytes_before_external_group_by = 4000000000,
        max_execution_time = 3600`;

  if (isDry) {
    console.log('\n[DRY RUN] SQL that would execute:');
    console.log(insertSql);
    return;
  }

  console.log(
    `\n[Step 1] Running INSERT (throttled to max_threads=8)...`,
  );
  const startTime = Date.now();
  await runClickhouseMigrationCommands([insertSql]);
  const elapsedSec = Math.round((Date.now() - startTime) / 1000);
  console.log(
    `  Done in ${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`,
  );

  console.log('\n' + '='.repeat(60));
  console.log('  CHUNK COMPLETE');
  console.log('='.repeat(60));
}

export async function down() {
  console.log('No down migration');
}
