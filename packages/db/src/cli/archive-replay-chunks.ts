/**
 * archive-replay-chunks
 * ----------------------
 * Copies `session_replay_chunks` from ClickHouse to Azure Blob (Parquet) so we
 * keep every replay forever, while ClickHouse only holds a rolling hot window.
 *
 * ClickHouse writes the Parquet DIRECTLY to Blob via the azureBlobStorage()
 * table function (validated on prod), so this script is a thin orchestrator —
 * no replay bytes flow through Node.
 *
 * Design (all validated against prod, see docs/session-replay-blob-archive.md):
 *  - Watermark = the set of settled days NOT yet in `replay_archive_index`.
 *    Oldest-first, so a missed/failed day is retried next run (no gaps).
 *  - "Settled" = dt <= today - SETTLE_DAYS, so all of a day's chunks have landed.
 *    Also skips clock-skew garbage partitions (e.g. year-2055).
 *  - Big days OOM if sorted whole (huge payloads), so a day is split into
 *    ceil(sizeGiB / TARGET_BUCKET_GIB) session-hash buckets:
 *    `cityHash64(session_id) % N` keeps every session's chunks in ONE file.
 *  - Every export runs with memory guardrails (threads / block size / a hard
 *    max_memory_usage ceiling) so it can never threaten the server.
 *  - Idempotent: overwrites the day's blob path; index is ReplacingMergeTree.
 *  - Verifies blob rowcount == CH rowcount BEFORE writing the index (which is
 *    the "done" marker + the watermark). Stops on mismatch — never advances
 *    past an unverified day.
 *
 * Env:
 *   CLICKHOUSE_URL                       (required) — used by the shared ch client
 *   AZURE_BLOB_CONNECTION_STRING         (required) — passed into azureBlobStorage()
 *   REPLAY_ARCHIVE_CONTAINER             blob container            (default clickhouse-export)
 *   REPLAY_ARCHIVE_SETTLE_DAYS           only archive dt <= today-N (default 2)
 *   REPLAY_ARCHIVE_TARGET_BUCKET_GIB     GiB per slice            (default 5)
 *   REPLAY_ARCHIVE_MAX_DAYS_PER_RUN      cap days per invocation  (default 1)
 *   REPLAY_ARCHIVE_MAX_THREADS           CH max_threads           (default 3)
 *   REPLAY_ARCHIVE_MAX_BLOCK_SIZE        CH max_block_size        (default 8192)
 *   REPLAY_ARCHIVE_MAX_MEMORY_BYTES      CH max_memory_usage      (default 15e9)
 *   REPLAY_ARCHIVE_MAX_EXEC_SEC          CH max_execution_time    (default 900)
 *   REPLAY_ARCHIVE_ENRICH_PROFILE        join events for profile_id (default true)
 *   REPLAY_ARCHIVE_DRY_RUN               plan only, no writes     (default false)
 */
import { ch, chQuery } from '../clickhouse/client';

const CONTAINER = process.env.REPLAY_ARCHIVE_CONTAINER || 'clickhouse-export';
const CONN = process.env.AZURE_BLOB_CONNECTION_STRING || '';
const SETTLE_DAYS = int('REPLAY_ARCHIVE_SETTLE_DAYS', 2);
const TARGET_BUCKET_GIB = num('REPLAY_ARCHIVE_TARGET_BUCKET_GIB', 5);
const MAX_DAYS_PER_RUN = int('REPLAY_ARCHIVE_MAX_DAYS_PER_RUN', 1);
const MAX_THREADS = int('REPLAY_ARCHIVE_MAX_THREADS', 3);
const MAX_BLOCK_SIZE = int('REPLAY_ARCHIVE_MAX_BLOCK_SIZE', 8192);
const MAX_MEMORY_BYTES = int('REPLAY_ARCHIVE_MAX_MEMORY_BYTES', 15_000_000_000);
const MAX_EXEC_SEC = int('REPLAY_ARCHIVE_MAX_EXEC_SEC', 900);
const ENRICH_PROFILE = process.env.REPLAY_ARCHIVE_ENRICH_PROFILE !== 'false';
const DRY_RUN = process.env.REPLAY_ARCHIVE_DRY_RUN === 'true';

const TABLE = 'session_replay_chunks';
const INDEX = 'replay_archive_index';
const GiB = 1024 ** 3;
// Guard against absurd partitions in either direction (clock skew).
const MIN_DAY = '2020-01-01';

function int(key: string, def: number): number {
  const v = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}
function num(key: string, def: number): number {
  const v = Number.parseFloat(process.env[key] ?? '');
  return Number.isFinite(v) ? v : def;
}
function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[archive-replay] ${msg}`);
}
/** YYYYMMDD partition string -> YYYY-MM-DD (or null if not a plausible date). */
function partitionToDate(p: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(p);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Memory-bounded settings applied to every heavy export. */
const EXPORT_SETTINGS = {
  max_threads: MAX_THREADS,
  max_block_size: MAX_BLOCK_SIZE,
  max_memory_usage: MAX_MEMORY_BYTES,
  max_execution_time: MAX_EXEC_SEC,
} as const;

type DayPlan = { date: string; dayInt: number; bytes: number; buckets: number };

/** Days that have data, are settled, valid, and NOT yet archived — oldest first. */
async function planDays(): Promise<DayPlan[]> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - SETTLE_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const parts = await chQuery<{ partition: string; bytes: string }>(
    `SELECT partition, sum(bytes_on_disk) AS bytes
       FROM system.parts
      WHERE table = '${TABLE}' AND active
      GROUP BY partition`,
  );
  const archived = await chQuery<{ dt: string }>(
    `SELECT DISTINCT toString(dt) AS dt FROM ${INDEX}`,
  );
  const done = new Set(archived.map((r) => r.dt));

  const plans: DayPlan[] = [];
  for (const p of parts) {
    const date = partitionToDate(p.partition);
    if (!date) continue; // unparseable partition
    if (date < MIN_DAY || date > cutoffStr) continue; // future/garbage or not settled
    if (done.has(date)) continue; // already archived
    const bytes = Number(p.bytes);
    const buckets = Math.max(1, Math.ceil(bytes / GiB / TARGET_BUCKET_GIB));
    plans.push({
      date,
      dayInt: Number(p.partition),
      bytes,
      buckets,
    });
  }
  plans.sort((a, b) => a.date.localeCompare(b.date)); // oldest first
  return plans;
}

function blobPathExpr(date: string, buckets: number): string {
  // Per-session bucket so retrieval reads exactly one file.
  return `concat('dt=${date}/project_id=', c.project_id, '/bucket=', toString(cityHash64(c.session_id) % ${buckets}), '.parquet')`;
}

async function exportBucket(
  plan: DayPlan,
  bucket: number,
): Promise<void> {
  const path = `dt=${plan.date}/project_id={_partition_id}/bucket=${bucket}.parquet`;
  const query = `
    INSERT INTO FUNCTION azureBlobStorage(
      '${CONN}', '${CONTAINER}', '${path}', 'Parquet')
    PARTITION BY project_id
    SELECT * FROM ${TABLE}
     WHERE toYYYYMMDD(started_at) = ${plan.dayInt}
       AND cityHash64(session_id) % ${plan.buckets} = ${bucket}
     ORDER BY project_id, session_id, started_at, chunk_index`;
  await ch.command({ query, clickhouse_settings: EXPORT_SETTINGS });
}

async function verifyDay(plan: DayPlan): Promise<boolean> {
  const [blob] = await chQuery<{ n: string }>(
    `SELECT count() AS n FROM azureBlobStorage(
       '${CONN}', '${CONTAINER}', 'dt=${plan.date}/**/*.parquet', 'Parquet')`,
    { max_execution_time: MAX_EXEC_SEC },
  );
  const [src] = await chQuery<{ n: string }>(
    `SELECT count() AS n FROM ${TABLE} WHERE toYYYYMMDD(started_at) = ${plan.dayInt}`,
    { max_execution_time: MAX_EXEC_SEC },
  );
  const blobN = Number(blob?.n ?? -1);
  const srcN = Number(src?.n ?? -2);
  log(`  verify: blob=${blobN} ch=${srcN} ${blobN === srcN ? 'OK' : 'MISMATCH'}`);
  return blobN === srcN;
}

async function populateIndex(plan: DayPlan): Promise<void> {
  const profileSelect = ENRICH_PROFILE
    ? 'any(e.profile_id)'
    : `''`;
  const profileJoin = ENRICH_PROFILE
    ? `LEFT JOIN (
         SELECT session_id, argMax(profile_id, created_at) AS profile_id
           FROM events
          WHERE toYYYYMMDD(created_at) = ${plan.dayInt} AND session_id != ''
          GROUP BY session_id
       ) e ON c.session_id = e.session_id`
    : '';
  const query = `
    INSERT INTO ${INDEX}
      (project_id, session_id, profile_id, dt, blob_path, chunks, first_started_at, last_started_at)
    SELECT
      c.project_id,
      c.session_id,
      ${profileSelect} AS profile_id,
      toDate('${plan.date}') AS dt,
      ${blobPathExpr(plan.date, plan.buckets)} AS blob_path,
      count() AS chunks,
      min(c.started_at) AS first_started_at,
      max(c.started_at) AS last_started_at
    FROM ${TABLE} c
    ${profileJoin}
    WHERE toYYYYMMDD(c.started_at) = ${plan.dayInt}
    GROUP BY c.project_id, c.session_id`;
  await ch.command({
    query,
    clickhouse_settings: {
      max_threads: MAX_THREADS,
      max_memory_usage: MAX_MEMORY_BYTES,
      max_execution_time: MAX_EXEC_SEC,
    },
  });
}

async function archiveDay(plan: DayPlan): Promise<boolean> {
  const gib = (plan.bytes / GiB).toFixed(1);
  log(`day ${plan.date}: ${gib} GiB -> ${plan.buckets} bucket(s)`);
  if (DRY_RUN) {
    log('  DRY_RUN: skipping export/index');
    return true;
  }
  for (let b = 0; b < plan.buckets; b++) {
    const t0 = Date.now();
    await exportBucket(plan, b);
    log(`  bucket ${b + 1}/${plan.buckets} exported (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  if (!(await verifyDay(plan))) {
    log(`  STOP: ${plan.date} count mismatch — leaving unarchived for retry`);
    return false;
  }
  await populateIndex(plan);
  log(`  index populated — ${plan.date} done`);
  return true;
}

async function main(): Promise<void> {
  if (!CONN) throw new Error('AZURE_BLOB_CONNECTION_STRING is required');
  log(
    `start container=${CONTAINER} settleDays=${SETTLE_DAYS} bucketGiB=${TARGET_BUCKET_GIB} maxDays=${MAX_DAYS_PER_RUN} enrichProfile=${ENRICH_PROFILE} dryRun=${DRY_RUN}`,
  );
  const plans = await planDays();
  if (plans.length === 0) {
    log('nothing to archive — all settled days already indexed');
    return;
  }
  const batch = plans.slice(0, MAX_DAYS_PER_RUN);
  log(`${plans.length} day(s) pending; processing ${batch.length} this run: ${batch.map((p) => p.date).join(', ')}`);

  let ok = 0;
  for (const plan of batch) {
    const success = await archiveDay(plan);
    if (!success) break; // stop-on-failure keeps the watermark gapless
    ok++;
  }
  log(`done: archived ${ok}/${batch.length} day(s) this run`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[archive-replay] FATAL', err);
    process.exit(1);
  });
