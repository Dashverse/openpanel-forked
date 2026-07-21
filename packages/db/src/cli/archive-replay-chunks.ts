/**
 * archive-replay-chunks — copy `session_replay_chunks` from ClickHouse to Azure
 * Blob as Parquet, so replays are kept forever while ClickHouse holds only a
 * rolling hot window. ClickHouse streams the Parquet directly to Blob via the
 * azureBlobStorage() table function, so this script only orchestrates — no
 * replay bytes flow through Node.
 *
 * A day is exported as one blob per (project, session_id-range) slice. Slicing
 * on a session_id range (a prefix of the table's ORDER BY key) lets ClickHouse
 * seek to each slice instead of re-scanning the day, keeps each file small
 * enough to play back cheaply, and makes the job resumable per slice.
 *
 * Oldest-settled day first; each slice is verified (blob count == CH count) and
 * indexed before the next. Re-running is safe: finished slices are skipped and
 * re-exports overwrite their blob.
 *
 * See docs/session-replay-blob-archive.md. Env: CLICKHOUSE_URL,
 * AZURE_BLOB_CONNECTION_STRING (required) + REPLAY_ARCHIVE_* overrides below.
 */
import type { ClickHouseSettings } from '@clickhouse/client';
import { ch, chQuery } from '../clickhouse/client';

const CONTAINER = process.env.REPLAY_ARCHIVE_CONTAINER || 'clickhouse-export';
const CONN = process.env.AZURE_BLOB_CONNECTION_STRING || '';
const SETTLE_DAYS = int('REPLAY_ARCHIVE_SETTLE_DAYS', 2);
const TARGET_SLICE_GIB = num('REPLAY_ARCHIVE_TARGET_SLICE_GIB', 5);
const MAX_DAYS_PER_RUN = int('REPLAY_ARCHIVE_MAX_DAYS_PER_RUN', 1);
const MAX_THREADS = int('REPLAY_ARCHIVE_MAX_THREADS', 2);
const MAX_BLOCK_SIZE = int('REPLAY_ARCHIVE_MAX_BLOCK_SIZE', 512);
const MAX_MEMORY_BYTES = int('REPLAY_ARCHIVE_MAX_MEMORY_BYTES', 15_000_000_000);
const MAX_EXEC_SEC = int('REPLAY_ARCHIVE_MAX_EXEC_SEC', 1800);
const ROW_GROUP_BYTES = int('REPLAY_ARCHIVE_ROW_GROUP_BYTES', 64 * 1024 * 1024);
const ENRICH_PROFILE = process.env.REPLAY_ARCHIVE_ENRICH_PROFILE !== 'false';
const DRY_RUN = process.env.REPLAY_ARCHIVE_DRY_RUN === 'true';

const TABLE = 'session_replay_chunks';
const INDEX = 'replay_archive_index';
const GiB = 1024 ** 3;
const MIN_DAY = '2020-01-01'; // floor for clock-skew partition guard
const HEX = '0123456789abcdef'; // session_id is a lowercase-hex UUIDv4
const ALLOWED_SLICES = [1, 2, 4, 8, 16] as const; // divisors of 16 (one hex char)

// Peak memory is bounded by the Parquet row group (flushed and freed at this
// size), not by slice or day size. A 64 MiB cap holds peak ~3 GiB and keeps
// every column chunk far under the 2 GiB Arrow array limit — the setting that
// unblocked big-day exports. The client types byte/count settings as string.
const EXPORT_SETTINGS: ClickHouseSettings = {
  max_threads: MAX_THREADS,
  max_block_size: String(MAX_BLOCK_SIZE),
  max_memory_usage: String(MAX_MEMORY_BYTES),
  max_execution_time: MAX_EXEC_SEC,
  output_format_parquet_row_group_size_bytes: String(ROW_GROUP_BYTES),
  azure_truncate_on_insert: 1, // overwrite on retry instead of erroring
  // Our blob path contains `project_id=<id>`, which ClickHouse would otherwise
  // read as a Hive partition column that collides with the real project_id in
  // SELECT * ("columns don't match, 9 vs 8"). We key on the index, not the
  // path, so Hive partitioning must be off on both write and read.
  use_hive_partitioning: 0,
};

/** Reads of azureBlobStorage must also disable Hive partitioning (see above). */
const READ_SETTINGS: ClickHouseSettings = {
  max_execution_time: MAX_EXEC_SEC,
  use_hive_partitioning: 0,
};

const INDEX_SETTINGS: ClickHouseSettings = {
  max_threads: MAX_THREADS,
  max_memory_usage: String(MAX_MEMORY_BYTES),
  max_execution_time: MAX_EXEC_SEC,
};

type DayPlan = { date: string; dayInt: number; bytes: number; rows: number };
type ProjectPlan = {
  projectId: string;
  rows: number;
  bytes: number;
  slices: number;
};

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
function partitionToDate(p: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(p);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
function blobPath(date: string, projectId: string, slice: number): string {
  return `dt=${date}/project_id=${projectId}/s=${slice}.parquet`;
}

/** Smallest allowed slice count that keeps each slice under the target size. */
function sliceCountFor(bytes: number): number {
  const want = Math.ceil(bytes / GiB / TARGET_SLICE_GIB);
  return ALLOWED_SLICES.find((n) => n >= want) ?? 16;
}

/**
 * Session_id prefixes between slices; n=4 -> ['4','8','c']. The first and last
 * slices are open-ended so a non-UUID session_id still lands in exactly one
 * slice (else it would be exported by none and fail the rowcount check).
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

/** Settled, valid, not-yet-fully-archived days with data — oldest first. */
async function planDays(): Promise<DayPlan[]> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - SETTLE_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const parts = await chQuery<{
    partition: string;
    bytes: string;
    rows: string;
  }>(
    `SELECT partition, sum(bytes_on_disk) AS bytes, sum(rows) AS rows
       FROM system.parts
      WHERE table = '${TABLE}' AND database = currentDatabase() AND active
      GROUP BY partition`,
  );
  // Done = index chunk-total equals source rows. A partially-indexed day (a run
  // that died mid-day) is not "done", so it retries and only re-exports its
  // missing slices.
  const indexed = await chQuery<{ dt: string; chunks: string }>(
    `SELECT toString(dt) AS dt, sum(chunks) AS chunks FROM ${INDEX} FINAL GROUP BY dt`,
  );
  const indexedChunks = new Map(indexed.map((r) => [r.dt, Number(r.chunks)]));

  const plans: DayPlan[] = [];
  for (const p of parts) {
    const date = partitionToDate(p.partition);
    if (!date) continue;
    if (date < MIN_DAY || date > cutoffStr) continue; // garbage/future or unsettled
    const rows = Number(p.rows);
    if (rows === 0) continue; // TTL husk — nothing to archive
    if (indexedChunks.get(date) === rows) continue; // fully archived
    plans.push({
      date,
      dayInt: Number(p.partition),
      bytes: Number(p.bytes),
      rows,
    });
  }
  return plans.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Projects on a day, sized for slice-count selection. Reads only project_id
 * (the leading key column), so it's cheap even on a 70 GiB day.
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
    const bytes = day.rows > 0 ? (day.bytes * n) / day.rows : 0; // split by row share
    return {
      projectId: r.project_id,
      rows: n,
      bytes,
      slices: sliceCountFor(bytes),
    };
  });
}

async function indexedChunksForSlice(path: string): Promise<number> {
  const [row] = await chQuery<{ n: string }>(
    `SELECT sum(chunks) AS n FROM ${INDEX} FINAL WHERE blob_path = '${esc(path)}'`,
    { max_execution_time: MAX_EXEC_SEC },
  );
  return Number(row?.n ?? 0);
}

async function countSlice(
  day: DayPlan,
  p: ProjectPlan,
  i: number,
): Promise<number> {
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
    READ_SETTINGS,
  );
  return Number(row?.n ?? -1);
}

/**
 * Export one slice. No ORDER BY (the table is already stored in key order;
 * sorting fat payloads OOM'd) and no PARTITION BY (it buffers a block per
 * partition, scaling memory with output — ClickHouse #88666); the path is fixed.
 */
async function exportSlice(
  day: DayPlan,
  p: ProjectPlan,
  i: number,
): Promise<void> {
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
 * Index every session in one slice (all live in `s=i.parquet`, so blob_path is
 * constant). Written per slice so a crash resumes at slice granularity.
 */
async function populateSliceIndex(
  day: DayPlan,
  p: ProjectPlan,
  i: number,
): Promise<void> {
  const path = blobPath(day.date, p.projectId, i);
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
  const query = `
    INSERT INTO ${INDEX}
      (project_id, session_id, profile_id, dt, blob_path, chunks, first_started_at, last_started_at)
    SELECT
      c.project_id,
      c.session_id,
      ${profileSelect} AS profile_id,
      toDate('${day.date}') AS dt,
      '${esc(path)}' AS blob_path,
      count() AS chunks,
      min(c.started_at) AS first_started_at,
      max(c.started_at) AS last_started_at
    FROM ${TABLE} c
    ${profileJoin}
    WHERE toYYYYMMDD(c.started_at) = ${day.dayInt}
      AND c.project_id = '${esc(p.projectId)}'
      AND ${slicePredicate(p.slices, i)}
    GROUP BY c.project_id, c.session_id`;
  await ch.command({ query, clickhouse_settings: INDEX_SETTINGS });
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
    await populateSliceIndex(day, p, i);
    log(
      `    slice ${i}: ${expected} chunks verified + indexed (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
  }
  return true;
}

async function verifyDay(day: DayPlan): Promise<boolean> {
  const blobN = await countBlob(`dt=${day.date}/**/*.parquet`);
  const [src] = await chQuery<{ n: string }>(
    `SELECT count() AS n FROM ${TABLE} WHERE toYYYYMMDD(started_at) = ${day.dayInt}`,
    { max_execution_time: MAX_EXEC_SEC },
  );
  const srcN = Number(src?.n ?? -2);
  log(
    `  verify day: blob=${blobN} ch=${srcN} ${blobN === srcN ? 'OK' : 'MISMATCH'}`,
  );
  return blobN === srcN;
}

async function archiveDay(day: DayPlan): Promise<boolean> {
  log(
    `day ${day.date}: ${(day.bytes / GiB).toFixed(1)} GiB / ${day.rows} rows`,
  );
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
    `start container=${CONTAINER} settleDays=${SETTLE_DAYS} sliceGiB=${TARGET_SLICE_GIB} maxDays=${MAX_DAYS_PER_RUN} blockSize=${MAX_BLOCK_SIZE} dryRun=${DRY_RUN}`,
  );

  const plans = await planDays();
  if (plans.length === 0) {
    log('nothing to archive — all settled days already indexed');
    return;
  }
  const batch = plans.slice(0, MAX_DAYS_PER_RUN);
  log(
    `${plans.length} day(s) pending; processing ${batch.length}: ${batch.map((p) => p.date).join(', ')}`,
  );

  let ok = 0;
  for (const day of batch) {
    if (!(await archiveDay(day))) break; // stop-on-failure keeps the watermark gapless
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
