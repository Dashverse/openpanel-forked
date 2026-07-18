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
 *   Dry-run one day (whole-day, no project split):
 *     pnpm migrate:deploy:code -- 22 --cluster --dry \
 *       --start="2026-07-05 00:00:00" --end="2026-07-06 00:00:00" --no-record
 *
 *   Execute one day (whole-day):
 *     pnpm migrate:deploy:code -- 22 --cluster \
 *       --start="2026-07-05 00:00:00" --end="2026-07-06 00:00:00" --no-record
 *
 *   Execute one day PER-PROJECT (5 sequential INSERTs, ~40% less scan overhead):
 *     pnpm migrate:deploy:code -- 22 --cluster \
 *       --start="2026-06-30 00:00:00" --end="2026-07-01 00:00:00" \
 *       --projects=dashreels,shortreels,frameo,studio,growth-tool \
 *       --no-record
 *
 * Per-project rationale: events sort key is
 * `(project_id, toDate(created_at), created_at, name)`. Without project_id in
 * WHERE, cross-project boundary granules within each part contain rows from
 * two projects with unrelated date ranges → CH reads the whole granule.
 * Measured 2x over-read on whole-day INSERTs. Adding project_id to WHERE lets
 * the primary key jump directly to that project's block → near-zero over-read.
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
  const projectsArg = args.find((a: string) => a.startsWith('--projects='));

  const start = startArg ? startArg.split('=')[1]! : null;
  const end = endArg ? endArg.split('=')[1]! : null;
  // Comma-separated project IDs. If null → single whole-day INSERT (legacy).
  // If provided → loop per project sequentially.
  const projects = projectsArg
    ? projectsArg
        .split('=')[1]!
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  return {
    start,
    end,
    projects,
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

// SETTINGS applied to every INSERT (whole-day and per-project alike).
//   - Blocks of ~1M rows / ~10 MiB flow through the Null table
//   - Backfill MV aggregates each block into partial states → v2
//   - Peak memory: ~200 MB per block (not per-window), way under Aiven's cap
//   - `optimize_trivial_insert_select=1` aligns SELECT parallelism with insert
//   - `max_threads=8`, `max_insert_threads=8` — measured peak memory at
//     4 threads was 3.9 GiB (6× headroom vs Aiven's 23 GB cap); 8 threads
//     estimated ~6 GiB. Trades 4→8 CPU for ~2× read throughput.
//   - `max_execution_time=36000` (10h) — safety ceiling. Real-world:
//     07-06 whole-day (157M events, sequential, threads=6) took 7h 17m.
//     At threads=8 expect ~5h 30m per full day, ~1-2h per project.
const INSERT_SETTINGS = `
  max_insert_threads = 8,
  max_threads = 8,
  min_insert_block_size_bytes_for_materialized_views = 10485760,
  min_insert_block_size_rows_for_materialized_views = 1000000,
  optimize_trivial_insert_select = 1,
  max_execution_time = 36000`;

async function countEvents(
  start: string,
  end: string,
  projectId: string | null,
): Promise<number> {
  const projectFilter = projectId
    ? `AND project_id = '${projectId}'`
    : '';
  const res = await chMigrationClient.query({
    query: `
      SELECT count() AS total
      FROM default.events
      WHERE created_at >= toDateTime('${start}')
        AND created_at < toDateTime('${end}')
        ${projectFilter}`,
    format: 'JSONEachRow',
  });
  return Number((await res.json<{ total: string }>())[0]?.total ?? 0);
}

function formatDuration(elapsedMs: number): string {
  const elapsedSec = Math.round(elapsedMs / 1000);
  return `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
}

export async function up() {
  const { start, end, projects, isCluster, isDry } = parseArgs();

  // Manual per-window migration. No-op if the auto migrate:deploy loop imports
  // it during deploy so it never crashes CI.
  if (!start || !end) {
    console.log(
      '[22-null-backfill] No --start/--end provided — manual per-window migration, skipping.',
    );
    console.log(
      '   Run whole-day: pnpm migrate:deploy:code -- 22 --cluster \\',
    );
    console.log(
      '     --start="2026-07-05 00:00:00" --end="2026-07-06 00:00:00" --no-record',
    );
    console.log(
      '   Run per-project: add --projects=dashreels,shortreels,frameo,studio,growth-tool',
    );
    return;
  }

  const mode = projects && projects.length > 0 ? 'PER-PROJECT' : 'WHOLE-DAY';
  console.log('='.repeat(60));
  console.log(`  BACKFILL ${V2_TABLE} (via Null-engine staging)`);
  console.log(`  Window: ${start}  →  ${end}`);
  console.log(`  Mode:   ${isDry ? 'DRY RUN' : 'EXECUTE'} · ${mode}`);
  if (projects && projects.length > 0) {
    console.log(`  Projects: ${projects.join(', ')} (${projects.length} sequential INSERTs)`);
  }
  console.log('='.repeat(60));

  // ─── Step 0: expected event counts (per project if split, else whole-day) ──
  console.log(`\n[Step 0] Expected events in [${start}, ${end}):`);
  const projectCounts: Array<{ project: string | null; expected: number }> = [];
  let totalExpected = 0;

  if (projects && projects.length > 0) {
    for (const proj of projects) {
      const count = await countEvents(start, end, proj);
      projectCounts.push({ project: proj, expected: count });
      totalExpected += count;
      console.log(`  ${proj.padEnd(20)} ${count.toLocaleString().padStart(15)} events`);
    }
    console.log(`  ${'TOTAL'.padEnd(20)} ${totalExpected.toLocaleString().padStart(15)} events`);
  } else {
    const count = await countEvents(start, end, null);
    projectCounts.push({ project: null, expected: count });
    totalExpected = count;
    console.log(`  Raw events: ${count.toLocaleString()}`);
  }

  if (totalExpected === 0) {
    console.log('\n  Nothing to backfill for this window.');
    return;
  }

  // ─── Step 1: Ensure Null staging + backfill MV exist (idempotent) ─────────
  console.log(`\n[Step 1] Ensuring Null-engine staging + backfill MV exist...`);
  await ensureSetup(isCluster);
  console.log('  OK');

  // ─── Step 2: Run INSERT(s) ─────────────────────────────────────────────────
  // Whole-day: single INSERT.
  // Per-project: N sequential INSERTs, one per project, each hitting the
  // events primary key by project_id → near-zero granule over-read.
  if (isDry) {
    console.log('\n[DRY RUN] Would execute the following INSERT(s):');
    for (const { project } of projectCounts) {
      const projectFilter = project ? `AND project_id = '${project}'` : '';
      console.log(`\n--- ${project ?? 'whole-day'} ---`);
      console.log(`INSERT INTO default.${NULL_TABLE}
SELECT * FROM default.events
WHERE created_at >= toDateTime('${start}')
  AND created_at <  toDateTime('${end}')
  ${projectFilter}
SETTINGS${INSERT_SETTINGS}`);
    }
    return;
  }

  console.log(`\n[Step 2] Running ${projectCounts.length} INSERT(s)...`);
  const overallStart = Date.now();

  for (const { project, expected } of projectCounts) {
    const label = project ?? 'whole-day';
    const projectFilter = project ? `AND project_id = '${project}'` : '';
    const insertSql = `
      INSERT INTO default.${NULL_TABLE}
      SELECT * FROM default.events
      WHERE created_at >= toDateTime('${start}')
        AND created_at <  toDateTime('${end}')
        ${projectFilter}
      SETTINGS${INSERT_SETTINGS}`;

    console.log(`\n  ─── [${label}] expected ${expected.toLocaleString()} events ───`);
    const stepStart = Date.now();
    try {
      await runClickhouseMigrationCommands([insertSql]);
      console.log(`  [${label}] Done in ${formatDuration(Date.now() - stepStart)}`);
    } catch (err) {
      console.error(`  [${label}] FAILED after ${formatDuration(Date.now() - stepStart)}:`, err);
      // Continue with next project — better to backfill what we can than abort.
      // Failed project can be re-run individually via --projects=<name>.
    }
  }

  const overallElapsed = formatDuration(Date.now() - overallStart);
  console.log('\n' + '='.repeat(60));
  console.log(`  WINDOW COMPLETE in ${overallElapsed}`);
  console.log(`  Expected total: ${totalExpected.toLocaleString()} events`);
  console.log('='.repeat(60));
}

export async function down() {
  console.log('No down migration');
}
