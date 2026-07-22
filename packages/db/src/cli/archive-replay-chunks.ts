/**
 * archive-replay-chunks — copy `session_replay_chunks` from ClickHouse to Azure
 * Blob as zstd-compressed Native, so replays are kept forever while ClickHouse
 * holds only a rolling hot window. ClickHouse streams the bytes directly to Blob
 * via the azureBlobStorage() table function, so this script only orchestrates —
 * no replay bytes flow through Node.
 *
 * Format is ClickHouse Native (not Parquet): replay payloads are fat and uneven
 * (avg ~850 KB/row, max ~45 MB/row), and Parquet caps a single String column
 * chunk at 2 GiB (Arrow 32-bit offsets) with no honored byte-based row-group
 * splitter on this path — so fat slices overflowed one chunk and died. Native
 * has no per-column cap, streams block-by-block (bounded memory), and self-
 * describes its schema, so CH reads it straight back from Blob for serving.
 *
 * A day is exported as ONE BLOB PER SESSION (`session_id=<sid>.native.zst`) so
 * playback fetches a single ~10 MiB object in ~0.2s instead of scanning a
 * multi-GiB slice. ClickHouse writes them in one `INSERT ... PARTITION BY
 * session_id` statement per batch — it fans out a file per session on its own.
 *
 * Batches exist only to bound memory: PARTITION BY buffers per open partition,
 * so peak memory scales with the number of sessions in one statement (~200
 * sessions ~= 10 GiB). We split a project-day into session_id-range batches of
 * ~TARGET_SESSIONS_PER_BATCH each (a session_id prefix is a seek on the table's
 * ORDER BY key), so every statement stays under the memory ceiling.
 *
 * Oldest-settled day first; each day is verified (total blob rows == CH rows)
 * and indexed. Re-running is safe: finished batches are skipped (their sessions
 * are already indexed) and re-exports overwrite each session's blob.
 *
 * See docs/session-replay-blob-archive.md. Env: CLICKHOUSE_URL,
 * AZURE_BLOB_CONNECTION_STRING (required) + REPLAY_ARCHIVE_* overrides below.
 */
import type { ClickHouseSettings } from '@clickhouse/client';
import { ch, chQuery } from '../clickhouse/client';

const CONTAINER = process.env.REPLAY_ARCHIVE_CONTAINER || 'clickhouse-export';
const CONN = process.env.AZURE_BLOB_CONNECTION_STRING || '';
const SETTLE_DAYS = int('REPLAY_ARCHIVE_SETTLE_DAYS', 2);
// Sessions per PARTITION BY statement. Peak memory scales with this (~200
// sessions hit ~10 GiB peak on fat days); keep it well under max_memory_usage.
const TARGET_SESSIONS_PER_BATCH = int('REPLAY_ARCHIVE_SESSIONS_PER_BATCH', 200);
const MAX_DAYS_PER_RUN = int('REPLAY_ARCHIVE_MAX_DAYS_PER_RUN', 1);
const MAX_THREADS = int('REPLAY_ARCHIVE_MAX_THREADS', 1);
// Native streams block-by-block, so peak memory ~= max_block_size rows in
// flight (times threads). Payloads are fat AND cluster (~850 KB/row avg, up to
// ~45 MB), so a big block lands in a dense region and blows up: 4096 rows hit a
// ~10 GiB chunk and OOM'd. 512 keeps peak ~1-1.5 GiB — validated on the fattest
// slice (06-14 s=2, 30 GiB) at 2.51 GiB peak.
const MAX_BLOCK_SIZE = int('REPLAY_ARCHIVE_MAX_BLOCK_SIZE', 512);
const MAX_MEMORY_BYTES = int('REPLAY_ARCHIVE_MAX_MEMORY_BYTES', 15_000_000_000);
const MAX_EXEC_SEC = int('REPLAY_ARCHIVE_MAX_EXEC_SEC', 1800);
const ENRICH_PROFILE = process.env.REPLAY_ARCHIVE_ENRICH_PROFILE !== 'false';
const DRY_RUN = process.env.REPLAY_ARCHIVE_DRY_RUN === 'true';
// Re-archive days even if the index already marks them done. Set only for a
// one-off re-archive (e.g. migrating slice blobs -> per-session): fresh rows
// (newer archived_at) supersede the old ones via ReplacingMergeTree FINAL, so
// the index self-corrects without a DELETE (which the replication wedge blocks).
const REARCHIVE = process.env.REPLAY_ARCHIVE_REARCHIVE === 'true';

const TABLE = 'session_replay_chunks';
const INDEX = 'replay_archive_index';
const FORMAT = 'Native'; // no per-column size cap; self-describes its schema
const COMPRESSION = 'zstd'; // rrweb payloads compress ~10x
const GiB = 1024 ** 3;
const MIN_DAY = '2020-01-01'; // floor for clock-skew partition guard
const HEX = '0123456789abcdef'; // session_id is a lowercase-hex UUIDv4
const ALLOWED_SLICES = [1, 2, 4, 8, 16] as const; // divisors of 16 (one hex char)

// The client types byte/count settings as string.
const EXPORT_SETTINGS: ClickHouseSettings = {
  max_threads: MAX_THREADS,
  max_block_size: String(MAX_BLOCK_SIZE),
  max_memory_usage: String(MAX_MEMORY_BYTES),
  max_execution_time: MAX_EXEC_SEC,
  azure_truncate_on_insert: 1, // overwrite on retry instead of erroring
  // The blob path contains `project_id=<id>`; without this, CH reads it as a
  // Hive partition and invents a 9th column on write ("9 and 8"). Needed on
  // BOTH write (here) and read (READ_SETTINGS).
  use_hive_partitioning: 0,
};

// Our blob path contains `project_id=<id>`, which ClickHouse would otherwise
// read as a Hive partition column, adding a phantom column on read. We key on
// the index, not the path, so Hive partitioning must be off when reading back.
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
  sessions: number;
  slices: number;
};

function int(key: string, def: number): number {
  const v = Number.parseInt(process.env[key] ?? '', 10);
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
/**
 * INSERT path template. `{_partition_id}` is substituted by ClickHouse with each
 * PARTITION BY value (the session_id), so one statement writes one blob/session.
 */
function exportPathTemplate(date: string, projectId: string): string {
  return `dt=${date}/project_id=${projectId}/session_id={_partition_id}.native.zst`;
}

/** SQL expr for a session's own blob path — must match exportPathTemplate. */
function sessionPathExpr(date: string, projectId: string): string {
  return `concat('dt=${date}/project_id=${projectId}/session_id=', c.session_id, '.native.zst')`;
}

/** Smallest allowed batch count keeping each PARTITION BY under the mem ceiling. */
function sliceCountFor(sessions: number): number {
  const want = Math.ceil(sessions / TARGET_SESSIONS_PER_BATCH);
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
    if (!REARCHIVE && indexedChunks.get(date) === rows) continue; // fully archived
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
  const rows = await chQuery<{
    project_id: string;
    rows: string;
    sessions: string;
  }>(
    `SELECT toString(project_id) AS project_id, count() AS rows,
            uniqExact(session_id) AS sessions
       FROM ${TABLE}
      WHERE toYYYYMMDD(started_at) = ${day.dayInt}
      GROUP BY project_id
      ORDER BY project_id`,
    { max_execution_time: MAX_EXEC_SEC },
  );
  return rows.map((r) => {
    const n = Number(r.rows);
    const sessions = Number(r.sessions);
    const bytes = day.rows > 0 ? (day.bytes * n) / day.rows : 0; // split by row share
    return {
      projectId: r.project_id,
      rows: n,
      bytes,
      sessions,
      slices: sliceCountFor(sessions),
    };
  });
}

/** Chunks already indexed for the sessions in batch `i` (for resume/skip). */
async function indexedChunksForSlice(
  day: DayPlan,
  p: ProjectPlan,
  i: number,
): Promise<number> {
  const [row] = await chQuery<{ n: string }>(
    `SELECT sum(chunks) AS n FROM ${INDEX} FINAL
      WHERE dt = toDate('${day.date}')
        AND project_id = '${esc(p.projectId)}'
        AND ${slicePredicate(p.slices, i)}`,
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
       '${CONN}', '${CONTAINER}', '${path}', '${FORMAT}', '${COMPRESSION}')`,
    READ_SETTINGS,
  );
  return Number(row?.n ?? -1);
}

/**
 * Export one batch as one blob per session. `PARTITION BY session_id` makes
 * ClickHouse fan out a file per session (path from {_partition_id}); the batch's
 * session_id range bounds the number of open partitions (peak memory). No ORDER
 * BY — the table is already stored in key order (sorting fat payloads OOM'd).
 */
async function exportSlice(
  day: DayPlan,
  p: ProjectPlan,
  i: number,
): Promise<void> {
  const query = `
    INSERT INTO FUNCTION azureBlobStorage(
      '${CONN}', '${CONTAINER}', '${exportPathTemplate(day.date, p.projectId)}', '${FORMAT}', '${COMPRESSION}')
    PARTITION BY session_id
    SELECT * FROM ${TABLE}
     WHERE toYYYYMMDD(started_at) = ${day.dayInt}
       AND project_id = '${esc(p.projectId)}'
       AND ${slicePredicate(p.slices, i)}`;
  await ch.command({ query, clickhouse_settings: EXPORT_SETTINGS });
}

/**
 * Index every session in one batch. Each session's blob_path is its own file
 * (session_id=<sid>.native.zst), built to match exportPathTemplate. Written per
 * batch so a crash resumes at batch granularity.
 */
async function populateSliceIndex(
  day: DayPlan,
  p: ProjectPlan,
  i: number,
): Promise<void> {
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
      ${sessionPathExpr(day.date, p.projectId)} AS blob_path,
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
    `  project ${p.projectId}: ${(p.bytes / GiB).toFixed(1)} GiB / ${p.rows} rows / ${p.sessions} sessions -> ${p.slices} batch(es)`,
  );
  for (let i = 0; i < p.slices; i++) {
    const expected = await countSlice(day, p, i);
    if (expected === 0) {
      log(`    batch ${i}: empty, skipped`);
      continue;
    }
    if ((await indexedChunksForSlice(day, p, i)) === expected) {
      log(`    batch ${i}: already archived (${expected} chunks), skipped`);
      continue;
    }
    // PARTITION BY is atomic per statement — it either writes every session's
    // blob or throws (aborting the day). Per-batch blob-count verification would
    // need to read the batch back; the day-level verifyDay is the integrity gate.
    const t0 = Date.now();
    await exportSlice(day, p, i);
    await populateSliceIndex(day, p, i);
    log(
      `    batch ${i}: ${expected} chunks -> per-session blobs + indexed (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
  }
  return true;
}

async function verifyDay(day: DayPlan): Promise<boolean> {
  // Match only per-session blobs — a `s=<n>.native.zst` slice blob from an
  // earlier run would otherwise be double-counted during the transition.
  const blobN = await countBlob(`dt=${day.date}/**/session_id=*.native.zst`);
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
        `  DRY_RUN project ${p.projectId}: ${p.sessions} sessions -> ${p.slices} batch(es)`,
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
    `start container=${CONTAINER} settleDays=${SETTLE_DAYS} sessionsPerBatch=${TARGET_SESSIONS_PER_BATCH} maxDays=${MAX_DAYS_PER_RUN} blockSize=${MAX_BLOCK_SIZE} rearchive=${REARCHIVE} dryRun=${DRY_RUN}`,
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
