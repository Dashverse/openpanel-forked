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
 *    Also skips clock-skew garbage partitions (e.g. year-2055, year-2299).
 *  - A day is exported as one blob per (project_id, session_id-range) SLICE.
 *    The table is ORDER BY (project_id, session_id, started_at, chunk_index),
 *    so both slice predicates are a PREFIX of the primary key and ClickHouse
 *    seeks straight to the matching granules.
 *
 *    This replaced `cityHash64(session_id) % N` bucketing: a hash is not
 *    monotonic over session_id, so the primary index cannot be used and EVERY
 *    bucket re-scanned the WHOLE day (measured 16x read amplification, 462s
 *    per bucket). session_id is a UUIDv4 (crypto.randomUUID) whose first char
 *    is uniformly random over [0-9a-f], so prefix ranges are just as evenly
 *    sized as hash buckets — same distribution, 1/N the reads.
 *
 *  - Small output per file also keeps us clear of the Parquet 2 GiB array
 *    limit (Arrow uses INT32 offsets, so one column chunk cannot exceed 2^31
 *    bytes) which killed whole-day exports of fat `payload` columns.
 *  - Every export runs with memory guardrails (threads / block size / a hard
 *    max_memory_usage ceiling) so it can never threaten the server.
 *  - Idempotent + resumable at SLICE granularity: a finished slice is skipped
 *    on retry, and re-exporting overwrites its blob (azure_truncate_on_insert).
 *  - Verifies blob rowcount == CH rowcount for each slice BEFORE indexing it,
 *    then re-verifies the whole day. Never advances past unverified data.
 *
 * Env:
 *   CLICKHOUSE_URL                       (required) — used by the shared ch client
 *   AZURE_BLOB_CONNECTION_STRING         (required) — passed into azureBlobStorage()
 *   REPLAY_ARCHIVE_CONTAINER             blob container            (default clickhouse-export)
 *   REPLAY_ARCHIVE_SETTLE_DAYS           only archive dt <= today-N (default 2)
 *   REPLAY_ARCHIVE_TARGET_SLICE_GIB      GiB per slice            (default 5)
 *   REPLAY_ARCHIVE_MAX_DAYS_PER_RUN      cap days per invocation  (default 1)
 *   REPLAY_ARCHIVE_MAX_THREADS           CH max_threads           (default 2)
 *   REPLAY_ARCHIVE_MAX_BLOCK_SIZE        CH max_block_size        (default 512)
 *   REPLAY_ARCHIVE_MAX_MEMORY_BYTES      CH max_memory_usage      (default 15e9)
 *   REPLAY_ARCHIVE_MAX_EXEC_SEC          CH max_execution_time    (default 1800)
 *   REPLAY_ARCHIVE_ENRICH_PROFILE        join events for profile_id (default true)
 *   REPLAY_ARCHIVE_DRY_RUN               plan only, no writes     (default false)
 */
import { ch, chQuery } from '../clickhouse/client';

const CONTAINER = process.env.REPLAY_ARCHIVE_CONTAINER || 'clickhouse-export';
const CONN = process.env.AZURE_BLOB_CONNECTION_STRING || '';
const SETTLE_DAYS = int('REPLAY_ARCHIVE_SETTLE_DAYS', 2);
const TARGET_SLICE_GIB = num('REPLAY_ARCHIVE_TARGET_SLICE_GIB', 5);
const MAX_DAYS_PER_RUN = int('REPLAY_ARCHIVE_MAX_DAYS_PER_RUN', 1);
const MAX_THREADS = int('REPLAY_ARCHIVE_MAX_THREADS', 2);
// Peak memory scales with max_block_size * bytes-per-row, and `payload` rows
// average ~64 KB (up to 10 MB). Measured on prod: 1024 -> OOM / 2 GiB Parquet
// array; 128 -> 276 MiB peak. 512 keeps a wide margin while staying fast.
const MAX_BLOCK_SIZE = int('REPLAY_ARCHIVE_MAX_BLOCK_SIZE', 512);
const MAX_MEMORY_BYTES = int('REPLAY_ARCHIVE_MAX_MEMORY_BYTES', 15_000_000_000);
const MAX_EXEC_SEC = int('REPLAY_ARCHIVE_MAX_EXEC_SEC', 1800);
const ENRICH_PROFILE = process.env.REPLAY_ARCHIVE_ENRICH_PROFILE !== 'false';
const DRY_RUN = process.env.REPLAY_ARCHIVE_DRY_RUN === 'true';

const TABLE = 'session_replay_chunks';
const INDEX = 'replay_archive_index';
const GiB = 1024 ** 3;
// Guard against absurd partitions in either direction (clock skew).
const MIN_DAY = '2020-01-01';
/** session_id is a lowercase-hex UUIDv4, so its first char lives in here. */
const HEX = '0123456789abcdef';
/** Slice counts must divide 16 so each slice covers whole hex-prefix chars. */
const ALLOWED_SLICES = [1, 2, 4, 8, 16] as const;

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
function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Smallest allowed slice count that gets each slice under the target size. */
function sliceCountFor(bytes: number): number {
  const want = Math.ceil(bytes / GiB / TARGET_SLICE_GIB);
  return ALLOWED_SLICES.find((n) => n >= want) ?? 16;
}

/**
 * Boundaries between slices, as session_id prefixes. For n=4 -> ['4','8','c'].
 * Slice i is [boundary[i-1], boundary[i]); the first and last slices are left
 * OPEN-ENDED so that a session_id outside [0-9a-f] (a non-UUID id) still lands
 * in exactly one slice. Without that, such a row would be exported by no slice
 * and the day's rowcount verification would fail.
 */
function sliceBoundaries(n: number): string[] {
  const step = HEX.length / n;
  return Array.from({ length: n - 1 }, (_, i) => HEX[(i + 1) * step]!);
}

/** WHERE fragment selecting slice `i` of `n`. */
function slicePredicate(n: number, i: number): string {
  const b = sliceBoundaries(n);
  const parts: string[] = [];
  if (i > 0) parts.push(`session_id >= '${b[i - 1]}'`);
  if (i < n - 1) parts.push(`session_id < '${b[i]}'`);
  return parts.length ? parts.join(' AND ') : '1';
}

/**
 * SQL that recomputes a row's slice index — must mirror sliceBoundaries().
 * "How many boundaries is this session_id past?" is exactly the slice number,
 * and it is total over all strings (see the open-ended note above).
 */
function sliceIndexExpr(n: number, col = 'session_id'): string {
  if (n === 1) return '0';
  return sliceBoundaries(n)
    .map((b) => `(${col} >= '${b}')`)
    .join(' + ');
}

/** Memory-bounded settings applied to every heavy export. */
const EXPORT_SETTINGS = {
  max_threads: MAX_THREADS,
  max_block_size: MAX_BLOCK_SIZE,
  max_memory_usage: MAX_MEMORY_BYTES,
  max_execution_time: MAX_EXEC_SEC,
  // Overwrite the slice's blob on re-export instead of erroring
  // ("Object ... already exists"). This is what makes a retried slice
  // idempotent rather than a hard failure.
  azure_truncate_on_insert: 1,
} as const;

type DayPlan = { date: string; dayInt: number; bytes: number; rows: number };
type ProjectPlan = { projectId: string; rows: number; bytes: number; slices: number };

/** Days that have data, are settled, valid, and NOT yet archived — oldest first. */
async function planDays(): Promise<DayPlan[]> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - SETTLE_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const parts = await chQuery<{ partition: string; bytes: string; rows: string }>(
    `SELECT partition, sum(bytes_on_disk) AS bytes, sum(rows) AS rows
       FROM system.parts
      WHERE table = '${TABLE}' AND database = currentDatabase() AND active
      GROUP BY partition`,
  );
  // A day is "done" only when the index's chunk total equals the source row
  // count. This makes progress robust to a partially-written index (a run that
  // died mid-day): such a day is NOT treated as complete, so it is retried and
  // only its missing slices are re-exported. (Presence-only detection would
  // silently skip the remainder.)
  const indexed = await chQuery<{ dt: string; chunks: string }>(
    `SELECT toString(dt) AS dt, sum(chunks) AS chunks FROM ${INDEX} FINAL GROUP BY dt`,
  );
  const indexedChunks = new Map(indexed.map((r) => [r.dt, Number(r.chunks)]));

  const plans: DayPlan[] = [];
  for (const p of parts) {
    const date = partitionToDate(p.partition);
    if (!date) continue; // unparseable partition
    if (date < MIN_DAY || date > cutoffStr) continue; // future/garbage or not settled
    const rows = Number(p.rows);
    if (rows === 0) continue; // empty partition (TTL husk) — nothing to archive
    if (indexedChunks.get(date) === rows) continue; // fully archived + verified
    plans.push({ date, dayInt: Number(p.partition), bytes: Number(p.bytes), rows });
  }
  plans.sort((a, b) => a.date.localeCompare(b.date)); // oldest first
  return plans;
}

/**
 * Projects present on a day, each sized so we can pick a slice count.
 * Reads only the project_id column (the leading key column), so this is cheap
 * even on a 70 GiB day — it never touches `payload`.
 */
async function planProjects(day: DayPlan): Promise<ProjectPlan[]> {
  const rows = await chQuery<{ project_id: string; rows: string }>(
    `SELECT toString(project_id) AS project_id, count() AS rows
       FROM ${TABLE}
      WHERE toYYYYMMDD(started_at) = ${day.dayInt}
      GROUP BY project_id
      ORDER BY project_id`,
    { max_execution_time: MAX_EXEC_SEC },
  );
  return rows.map((r) => {
    const n = Number(r.rows);
    // bytes_on_disk is only known per partition, so split it by row share.
    const bytes = day.rows > 0 ? (day.bytes * n) / day.rows : 0;
    return { projectId: r.project_id, rows: n, bytes, slices: sliceCountFor(bytes) };
  });
}

function blobPath(date: string, projectId: string, slice: number): string {
  return `dt=${date}/project_id=${projectId}/s=${slice}.parquet`;
}

/** Rows already indexed for one slice — lets us skip finished work on retry. */
async function indexedChunksForSlice(path: string): Promise<number> {
  const [row] = await chQuery<{ n: string }>(
    `SELECT sum(chunks) AS n FROM ${INDEX} FINAL WHERE blob_path = '${esc(path)}'`,
    { max_execution_time: MAX_EXEC_SEC },
  );
  return Number(row?.n ?? 0);
}

async function countSlice(day: DayPlan, p: ProjectPlan, i: number): Promise<number> {
  const [row] = await chQuery<{ n: string }>(
    `SELECT count() AS n FROM ${TABLE}
      WHERE toYYYYMMDD(started_at) = ${day.dayInt}
        AND project_id = '${esc(p.projectId)}'
        AND ${slicePredicate(p.slices, i)}`,
    { max_execution_time: MAX_EXEC_SEC },
  );
  return Number(row?.n ?? 0);
}

async function countBlob(path: string): Promise<number> {
  const [row] = await chQuery<{ n: string }>(
    `SELECT count() AS n FROM azureBlobStorage(
       '${CONN}', '${CONTAINER}', '${path}', 'Parquet')`,
    { max_execution_time: MAX_EXEC_SEC },
  );
  return Number(row?.n ?? -1);
}

/**
 * Export one (project, session-range) slice.
 *
 * Deliberately NO `ORDER BY` (the table is already stored in that order, and
 * sorting fat payloads in memory OOM'd at ~18 GiB) and NO `PARTITION BY` (it
 * buffers one insert block per partition, so memory scaled with the OUTPUT —
 * see ClickHouse #88666). The path is a constant instead.
 */
async function exportSlice(day: DayPlan, p: ProjectPlan, i: number): Promise<void> {
  const query = `
    INSERT INTO FUNCTION azureBlobStorage(
      '${CONN}', '${CONTAINER}', '${blobPath(day.date, p.projectId, i)}', 'Parquet')
    SELECT * FROM ${TABLE}
     WHERE toYYYYMMDD(started_at) = ${day.dayInt}
       AND project_id = '${esc(p.projectId)}'
       AND ${slicePredicate(p.slices, i)}`;
  await ch.command({ query, clickhouse_settings: EXPORT_SETTINGS });
}

/**
 * Index every session of one project for the day, in a single pass.
 * `blob_path` is recomputed per row with the same boundaries the export used,
 * so each session points at the one file that holds all of its chunks.
 */
async function populateProjectIndex(day: DayPlan, p: ProjectPlan): Promise<void> {
  const profileSelect = ENRICH_PROFILE ? 'any(e.profile_id)' : `''`;
  const profileJoin = ENRICH_PROFILE
    ? `LEFT JOIN (
         SELECT session_id, argMax(profile_id, created_at) AS profile_id
           FROM events
          WHERE toYYYYMMDD(created_at) = ${day.dayInt}
            AND project_id = '${esc(p.projectId)}'
            AND session_id != ''
          GROUP BY session_id
       ) e ON c.session_id = e.session_id`
    : '';
  const pathExpr = `concat('dt=${day.date}/project_id=${esc(p.projectId)}/s=', toString(${sliceIndexExpr(
    p.slices,
    'c.session_id',
  )}), '.parquet')`;
  const query = `
    INSERT INTO ${INDEX}
      (project_id, session_id, profile_id, dt, blob_path, chunks, first_started_at, last_started_at)
    SELECT
      c.project_id,
      c.session_id,
      ${profileSelect} AS profile_id,
      toDate('${day.date}') AS dt,
      ${pathExpr} AS blob_path,
      count() AS chunks,
      min(c.started_at) AS first_started_at,
      max(c.started_at) AS last_started_at
    FROM ${TABLE} c
    ${profileJoin}
    WHERE toYYYYMMDD(c.started_at) = ${day.dayInt}
      AND c.project_id = '${esc(p.projectId)}'
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

async function archiveProject(day: DayPlan, p: ProjectPlan): Promise<boolean> {
  log(
    `  project ${p.projectId}: ${(p.bytes / GiB).toFixed(1)} GiB / ${p.rows} rows -> ${p.slices} slice(s)`,
  );
  for (let i = 0; i < p.slices; i++) {
    const path = blobPath(day.date, p.projectId, i);
    const expected = await countSlice(day, p, i);
    if (expected === 0) {
      log(`    slice ${i}: empty, skipped`);
      continue;
    }
    // Resume: a slice already indexed with the right chunk count is done.
    if ((await indexedChunksForSlice(path)) === expected) {
      log(`    slice ${i}: already archived (${expected} chunks), skipped`);
      continue;
    }
    const t0 = Date.now();
    await exportSlice(day, p, i);
    const got = await countBlob(path);
    if (got !== expected) {
      log(`    slice ${i}: MISMATCH blob=${got} ch=${expected} — aborting day`);
      return false;
    }
    log(
      `    slice ${i}: ${expected} chunks verified (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
  }
  await populateProjectIndex(day, p);
  return true;
}

async function verifyDay(day: DayPlan): Promise<boolean> {
  const blobN = await countBlob(`dt=${day.date}/**/*.parquet`);
  const [src] = await chQuery<{ n: string }>(
    `SELECT count() AS n FROM ${TABLE} WHERE toYYYYMMDD(started_at) = ${day.dayInt}`,
    { max_execution_time: MAX_EXEC_SEC },
  );
  const srcN = Number(src?.n ?? -2);
  log(`  verify day: blob=${blobN} ch=${srcN} ${blobN === srcN ? 'OK' : 'MISMATCH'}`);
  return blobN === srcN;
}

async function archiveDay(day: DayPlan): Promise<boolean> {
  log(`day ${day.date}: ${(day.bytes / GiB).toFixed(1)} GiB / ${day.rows} rows`);
  const projects = await planProjects(day);
  if (DRY_RUN) {
    for (const p of projects) {
      log(
        `  DRY_RUN project ${p.projectId}: ${(p.bytes / GiB).toFixed(1)} GiB -> ${p.slices} slice(s)`,
      );
    }
    return true;
  }
  for (const p of projects) {
    if (!(await archiveProject(day, p))) return false;
  }
  if (!(await verifyDay(day))) {
    log(`  STOP: ${day.date} count mismatch — leaving unarchived for retry`);
    return false;
  }
  log(`  ${day.date} done`);
  return true;
}

async function main(): Promise<void> {
  if (!CONN) throw new Error('AZURE_BLOB_CONNECTION_STRING is required');
  log(
    `start container=${CONTAINER} settleDays=${SETTLE_DAYS} sliceGiB=${TARGET_SLICE_GIB} maxDays=${MAX_DAYS_PER_RUN} blockSize=${MAX_BLOCK_SIZE} enrichProfile=${ENRICH_PROFILE} dryRun=${DRY_RUN}`,
  );
  const plans = await planDays();
  if (plans.length === 0) {
    log('nothing to archive — all settled days already indexed');
    return;
  }
  const batch = plans.slice(0, MAX_DAYS_PER_RUN);
  log(
    `${plans.length} day(s) pending; processing ${batch.length} this run: ${batch
      .map((p) => p.date)
      .join(', ')}`,
  );

  let ok = 0;
  for (const day of batch) {
    const success = await archiveDay(day);
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
