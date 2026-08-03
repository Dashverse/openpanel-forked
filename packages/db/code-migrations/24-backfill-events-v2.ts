import {
  chMigrationClient,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

/**
 * Backfill historical `events` → `events_v2` (the sort-key migration), one window
 * at a time, CPU-throttled.
 *
 * Unlike migration 22 (which staged through a Null-engine table to bound
 * AGGREGATION-state memory), this is a plain MergeTree copy — no aggregation. A
 * straight `INSERT INTO events_v2 SELECT * FROM events` already streams block by
 * block, so peak memory is just the per-block re-sort into the new key, not the
 * window size. The lever we care about here is CPU, controlled by max_threads.
 *
 * NO double-write: the live dual-write MV `events_to_v2` fires on INSERT INTO
 * `events` (source). This INSERTs INTO `events_v2` (target), which has no MV on
 * it — so a backfill INSERT never re-triggers the live MV.
 *
 * SEAM (T0): the live MV began at 2026-08-03 12:24:32. It owns everything inserted
 * at/after T0; the backfill owns created_at < T0. So the boundary day is run with
 * --end="2026-08-03 12:24:32" (never the full day) to avoid clobbering live rows.
 *
 * Idempotent + resumable per window:
 *   - events_v2 count == events count for [start,end) -> skip (re-applying the loop
 *     Job resumes where it left off; finished days are a ~1s count-check).
 *   - fresh window (count == 0) -> INSERT.
 *   - PARTIAL count (a prior crash) -> FAIL the job. We never auto-delete or
 *     re-insert on top of a partial (that would duplicate); clean + re-run that
 *     window manually if/when we decide to.
 *
 * CPU throttle (why 4 threads): migration 22 peaked 77% CPU at 8 threads with NO
 * competing writer. We now ALSO run the live dual-write MV, so we start at HALF
 * (4) and leave headroom. Tune via BACKFILL_MAX_THREADS if CPU stays cool. Pace
 * (sleep between days) + off-peak scheduling is done by the loop Job, not here.
 *
 * Manual finish steps (once ALL windows are backfilled — NOT done by this script):
 *   -- dedup the only partition that can hold seam overlap (late arrivals: old
 *   -- created_at inserted after T0 via the MV AND covered by the boundary backfill)
 *   OPTIMIZE TABLE events_v2 PARTITION 202608 DEDUPLICATE BY id;
 *
 * Usage:
 *   Dry-run one day:
 *     pnpm migrate:deploy:code -- 24 --cluster --dry --no-record \
 *       --start="2026-08-02 00:00:00" --end="2026-08-03 00:00:00"
 *   Execute one day:
 *     pnpm migrate:deploy:code -- 24 --cluster --no-record \
 *       --start="2026-08-02 00:00:00" --end="2026-08-03 00:00:00"
 *   Boundary day (scoped to T0):
 *     pnpm migrate:deploy:code -- 24 --cluster --no-record \
 *       --start="2026-08-03 00:00:00" --end="2026-08-03 12:24:32"
 *
 * Loop newest->oldest via the k8s Job (openpanel/k8s-manifests/prod/09-events-v2-backfill-job.yaml).
 */

const SRC = 'events';
const DST = 'events_v2';

function parseArgs() {
  const args = process.argv;
  const startArg = args.find((a: string) => a.startsWith('--start='));
  const endArg = args.find((a: string) => a.startsWith('--end='));

  return {
    start: startArg ? startArg.split('=')[1]! : null,
    end: endArg ? endArg.split('=')[1]! : null,
    isCluster: getIsCluster(),
    isDry: args.includes('--dry'),
  };
}

async function countWindow(
  table: string,
  start: string,
  end: string,
): Promise<number> {
  const res = await chMigrationClient.query({
    query: `SELECT count() AS total FROM default.${table}
            WHERE created_at >= toDateTime('${start}') AND created_at < toDateTime('${end}')`,
    format: 'JSONEachRow',
    // Cap the preflight/verify counts too — created_at prunes so these are cheap,
    // but nothing here should ever be able to run unbounded.
    clickhouse_settings: { max_execution_time: 120 },
  });
  return Number((await res.json<{ total: string }>())[0]?.total ?? 0);
}

export async function up() {
  const { start, end, isDry } = parseArgs();

  // No window => auto migrate:deploy loop imported it during a deploy. No-op so
  // CI never runs a giant unbounded copy.
  if (!start || !end) {
    console.log(
      '[24-backfill-events-v2] No --start/--end — manual per-window migration, skipping.',
    );
    console.log(
      '   Run: pnpm migrate:deploy:code -- 24 --cluster --no-record --start="D 00:00:00" --end="D+1 00:00:00"',
    );
    return;
  }

  // Validate the window before it touches SQL: both must be real datetimes and
  // start strictly before end. A malformed or inverted window otherwise returns
  // count 0, and the loop Job would silently mark that window "done" (skipping it)
  // — plus this hardens the string interpolation in countWindow / the INSERT.
  const DT = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2})?$/;
  if (!DT.test(start) || !DT.test(end)) {
    throw new Error(
      `Invalid --start/--end (expected "YYYY-MM-DD HH:MM:SS"): start="${start}" end="${end}"`,
    );
  }
  if (start >= end) {
    throw new Error(`Empty/inverted window: start="${start}" >= end="${end}"`);
  }

  const maxThreads = Number.parseInt(
    process.env.BACKFILL_MAX_THREADS || '4',
    10,
  );
  const maxExecSec = Number.parseInt(
    process.env.BACKFILL_MAX_EXEC_SEC || '18000',
    10,
  );
  // Guardrail only. A plain copy streams block-by-block so real peak is a few GB,
  // but this caps a runaway at ~20 GB (under Aiven's ~23 GB per-query ceiling) so
  // it dies as a recoverable Code 241 on THAT query, never OOMs the shared server.
  const maxMemoryBytes = process.env.BACKFILL_MAX_MEMORY_BYTES || '20000000000';

  console.log('='.repeat(60));
  console.log(`  BACKFILL ${SRC} -> ${DST}`);
  console.log(`  Window: [${start}, ${end})`);
  console.log(`  Mode:   ${isDry ? 'DRY RUN' : 'EXECUTE'}  threads=${maxThreads}`);
  console.log('='.repeat(60));

  // Step 0: source count
  const srcTotal = await countWindow(SRC, start, end);
  console.log(`\n[0] Source ${SRC}: ${srcTotal.toLocaleString()} rows`);
  if (srcTotal === 0) {
    console.log('    Nothing to backfill for this window.');
    return;
  }

  // Step 1: resume / idempotency check.
  const dstTotal = await countWindow(DST, start, end);
  console.log(`[1] Existing ${DST}: ${dstTotal.toLocaleString()} rows`);
  if (dstTotal === srcTotal) {
    console.log('    Already backfilled (counts match) — skipping.');
    return;
  }

  if (isDry) {
    if (dstTotal > 0) {
      console.log(
        `\n[DRY RUN] Partial (${dstTotal.toLocaleString()}/${srcTotal.toLocaleString()}) — would FAIL job (clean + re-run manually).`,
      );
    } else {
      console.log('\n[DRY RUN] Fresh window — would INSERT.');
    }
    return;
  }

  // A partial window means a prior run crashed mid-INSERT. We don't auto-clean or
  // re-insert on top (that would duplicate) — just fail the job so it's visible.
  // We monitor + clean + re-run this window manually if/when we decide to.
  if (dstTotal > 0) {
    throw new Error(
      `Partial ${DST} for [${start}, ${end}): ${dstTotal} of ${srcTotal} rows present — failing job; clean + re-run this window manually.`,
    );
  }

  // Step 2: the throttled copy. Streams block-by-block; re-sorts each block into
  // events_v2's key. 4 threads to leave CPU headroom next to the live MV.
  const insertSql = `
    INSERT INTO default.${DST}
    SELECT * FROM default.${SRC}
    WHERE created_at >= toDateTime('${start}') AND created_at < toDateTime('${end}')
    SETTINGS
      max_threads = ${maxThreads},
      max_insert_threads = ${maxThreads},
      max_insert_block_size = 1000000,
      optimize_trivial_insert_select = 1,
      max_memory_usage = ${maxMemoryBytes},
      max_execution_time = ${maxExecSec}`;

  console.log('\n[2] Running throttled INSERT ...');
  const t0 = Date.now();
  await runClickhouseMigrationCommands([insertSql]);
  const sec = Math.round((Date.now() - t0) / 1000);
  console.log(`    Done in ${Math.floor(sec / 60)}m ${sec % 60}s`);

  // Step 4: verify parity
  const dstAfter = await countWindow(DST, start, end);
  const ok = dstAfter === srcTotal;
  console.log(
    `\n[3] Verify: ${SRC}=${srcTotal.toLocaleString()} ${DST}=${dstAfter.toLocaleString()} -> ${ok ? 'MATCH ✓' : 'MISMATCH ✗ (re-run this window)'}`,
  );
  if (!ok) {
    throw new Error(
      `Row-count mismatch for [${start}, ${end}): ${SRC}=${srcTotal} ${DST}=${dstAfter}`,
    );
  }

  console.log('\n' + '='.repeat(60));
  console.log('  WINDOW COMPLETE');
  console.log('='.repeat(60));
}

export async function down() {
  console.log('No down migration (data-only backfill).');
}
