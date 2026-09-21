/**
 * delete-archived-replay-chunks — verify-gated DROP of old `session_replay_chunks`
 * partitions from ClickHouse, once the day is safely archived to Azure Blob.
 * This is what actually reclaims CH hot storage; the Blob keeps the data forever.
 *
 * DRY-RUN BY DEFAULT — drops NOTHING unless REPLAY_DELETE_DRY_RUN='false'.
 *
 * For each day that is (a) `status='archived'` in `replay_archive_days`,
 * (b) older than RETAIN_DAYS, and (c) not already `deletedAt`, it RE-VERIFIES
 * FRESH against the blobs — `index >= ch` count AND a content fingerprint on a
 * sample of sessions (CH bytes must equal Blob bytes) — and only then
 * `DROP PARTITION` + stamps `deletedAt`. A day that fails fresh verify is
 * skipped, marked `verify_failed`, and makes the run exit non-zero (alert).
 * The stored `archived` flag is NEVER the gate on its own.
 *
 * PREREQUISITE (operational, not enforceable here): serving-from-Blob must be
 * LIVE in prod, or a dropped day = blank replays. Keep DRY_RUN until you have
 * confirmed an old replay actually serves from Blob.
 *
 * Env: CLICKHOUSE_URL, AZURE_BLOB_CONNECTION_STRING, DATABASE_URL (required) +
 * REPLAY_DELETE_* below.
 */
import type { ClickHouseSettings } from '@clickhouse/client';
import { ch, chQuery } from '../clickhouse/client';
import {
  listDeletableDays,
  markDeleted,
  markVerifyFailed,
} from '../services/replay-archive-day.service';

const CONN = process.env.AZURE_BLOB_CONNECTION_STRING || '';
const CONTAINER = process.env.REPLAY_ARCHIVE_CONTAINER || 'clickhouse-export';
const TABLE = 'session_replay_chunks';
const INDEX = 'replay_archive_index';
const FORMAT = 'Native';
const COMPRESSION = 'zstd';

function int(key: string, def: number): number {
  const v = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}
// Keep this many days hot in CH; delete strictly older ones.
const RETAIN_DAYS = int('REPLAY_DELETE_RETAIN_DAYS', 30);
const MAX_DAYS_PER_RUN = int('REPLAY_DELETE_MAX_DAYS_PER_RUN', 5);
const MAX_EXEC_SEC = int('REPLAY_DELETE_MAX_EXEC_SEC', 1800);
const LIGHT_MEMORY = int('REPLAY_DELETE_LIGHT_MEMORY_BYTES', 8_000_000_000);
// SAFETY DEFAULT: drops nothing unless explicitly set to the string 'false'.
const DRY_RUN = process.env.REPLAY_DELETE_DRY_RUN !== 'false';

const SETTINGS: ClickHouseSettings = {
  max_memory_usage: String(LIGHT_MEMORY),
  max_execution_time: MAX_EXEC_SEC,
  // Blob path contains project_id=<id>; without this CH reads it as a Hive
  // partition and invents a phantom column.
  use_hive_partitioning: 0,
};

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[delete-replay] ${msg}`);
}
function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

type VerifyResult = {
  ok: boolean;
  empty?: boolean; // 0 chunks already in CH — nothing to drop, benign skip
  idxN: number; // replay_archive_index (ledger) chunk count for the day
  srcN: number; // CH chunk count for the day
  missing?: number; // CH chunks NOT present byte-identically in the blob
  reason?: string;
};

/** The day's blob glob — every per-session `native.zst` archived for that day. */
function dayGlob(dayStr: string): string {
  return `dt=${dayStr}/**/*.native.zst`;
}

/**
 * Re-verify a day FRESH, immediately before dropping it. The gate is a
 * WHOLE-DAY content proof read from the blob itself (not the ledger): every
 * chunk currently in CH must be present byte-identically in the day's blobs.
 *
 * Why not a sample: a per-session sample only opens the sampled files, so a
 * corrupt/missing blob for any un-sampled session (e.g. a large one) would pass
 * and the CH partition would be dropped → silent data loss. Reading the whole
 * day's glob (a) opens EVERY archived file, so a missing/unreadable one throws
 * (404 → non-zero exit) instead of silently reading as empty, and (b) an
 * all-missing day yields an empty set, so every CH chunk counts as "missing"
 * and the day fails closed. `cityHash64(payload)` keeps the NOT IN set to a
 * hash per row (~tens of MB), not the payload (~tens of GB). Because it is a
 * subset test (CH ⊆ blob), a day whose blob is a legitimate SUPERSET of CH
 * (chunks CH lost to TTL/merges) still verifies — no false failure on the 90d
 * TTL boundary. The stored `archived` status only picks candidates, never
 * proves anything.
 */
async function verifyForDeletion(
  dayStr: string,
  dayInt: number,
): Promise<VerifyResult> {
  const [idx] = await chQuery<{ n: string }>(
    `SELECT sum(chunks) AS n FROM ${INDEX} FINAL WHERE dt = toDate('${dayStr}')`,
    SETTINGS,
  );
  const [src] = await chQuery<{ n: string }>(
    `SELECT count() AS n FROM ${TABLE} WHERE toYYYYMMDD(started_at) = ${dayInt}`,
    SETTINGS,
  );
  const idxN = Number(idx?.n ?? -1);
  const srcN = Number(src?.n ?? -2);
  if (!Number.isFinite(idxN) || !Number.isFinite(srcN) || idxN < 0 || srcN < 0) {
    return { ok: false, idxN, srcN, reason: `unreadable counts index=${idxN} ch=${srcN}` };
  }
  if (srcN === 0) {
    // CH partition already empty — nothing to drop. Not a failure.
    return { ok: false, empty: true, idxN, srcN };
  }
  // Cheap pre-filter from the ledger: if even the recorded archive count is
  // short of what CH holds, the blob is incomplete — reject before paying for
  // the whole-day blob read.
  if (idxN < srcN) {
    return {
      ok: false,
      idxN,
      srcN,
      reason: `blob INCOMPLETE (ledger): index=${idxN} < ch=${srcN}`,
    };
  }
  // AUTHORITATIVE gate: whole-day CH ⊆ blob content proof (see docstring).
  const glob = dayGlob(dayStr);
  const [miss] = await chQuery<{ n: string }>(
    `SELECT count() AS n FROM ${TABLE}
      WHERE toYYYYMMDD(started_at) = ${dayInt}
        AND (session_id, chunk_index, cityHash64(payload)) NOT IN (
          SELECT session_id, chunk_index, cityHash64(payload)
          FROM azureBlobStorage(
            '${CONN}', '${CONTAINER}', '${esc(glob)}', '${FORMAT}', '${COMPRESSION}')
        )`,
    SETTINGS,
  );
  const missing = Number(miss?.n ?? -1);
  if (!Number.isFinite(missing) || missing < 0) {
    return { ok: false, idxN, srcN, reason: `unreadable subset count = ${miss?.n}` };
  }
  if (missing !== 0) {
    return {
      ok: false,
      idxN,
      srcN,
      missing,
      reason: `CONTENT MISMATCH: ${missing}/${srcN} CH chunks NOT byte-identical in blob`,
    };
  }
  log(
    `  verify ${dayStr}: ch=${srcN} ledger=${idxN} — whole-day CH⊆blob OK (0 missing)`,
  );
  return { ok: true, idxN, srcN, missing: 0 };
}

async function dropPartition(dayInt: number): Promise<void> {
  await ch.command({
    query: `ALTER TABLE ${TABLE} DROP PARTITION ${dayInt}`,
    clickhouse_settings: { max_execution_time: MAX_EXEC_SEC },
  });
}

async function main(): Promise<number> {
  if (!CONN) throw new Error('AZURE_BLOB_CONNECTION_STRING is required');
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RETAIN_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  log(
    `start dryRun=${DRY_RUN} retainDays=${RETAIN_DAYS} (delete days < ${cutoffStr}) maxDays=${MAX_DAYS_PER_RUN} verify=whole-day-CH⊆blob`,
  );

  const candidates = await listDeletableDays(cutoff, MAX_DAYS_PER_RUN);
  if (candidates.length === 0) {
    log('nothing eligible — no archived day older than the retain window');
    return 0;
  }
  log(
    `${candidates.length} candidate day(s): ${candidates.map((c) => c.day.toISOString().slice(0, 10)).join(', ')}`,
  );

  let dropped = 0;
  const failed: string[] = [];
  for (const c of candidates) {
    const dayStr = c.day.toISOString().slice(0, 10);
    const dayInt = Number(dayStr.replace(/-/g, ''));
    const v = await verifyForDeletion(dayStr, dayInt);

    if (v.empty) {
      // CH partition is already gone (90d TTL, or a prior manual/interrupted
      // drop) — the blob is still the record, so stamp the day deleted-from-CH
      // and move on. Without this the day stays a candidate forever (it is still
      // `archived` with `deletedAt IS NULL`) and, since each run takes only the
      // MAX_DAYS_PER_RUN oldest candidates, a backlog of TTL-emptied days sits
      // permanently at the head of the queue and starves every real deletion.
      log(`  skip ${dayStr}: CH partition already empty (0 chunks) — marking done`);
      if (!DRY_RUN) {
        await markDeleted(dayStr, 0, v.idxN).catch((e) =>
          log(`  WARN: status write failed on empty-skip: ${String(e)}`),
        );
      }
      continue;
    }
    if (!v.ok) {
      log(`  SKIP ${dayStr}: ${v.reason}`);
      failed.push(dayStr);
      await markVerifyFailed(dayStr, `delete verify failed: ${v.reason}`, {
        chChunks: v.srcN,
        blobChunks: v.idxN,
      }).catch((e) => log(`  WARN: status write failed: ${String(e)}`));
      continue;
    }
    if (DRY_RUN) {
      log(
        `  DRY_RUN would DROP PARTITION ${dayInt} (${dayStr}) — ${v.srcN} chunks, verified`,
      );
      continue;
    }
    await dropPartition(dayInt);
    await markDeleted(dayStr, v.srcN, v.idxN).catch((e) =>
      log(`  WARN: status write failed after drop: ${String(e)}`),
    );
    dropped++;
    log(`  DROPPED ${dayStr} (partition ${dayInt}) — ${v.srcN} chunks reclaimed from CH`);
  }

  log(
    `done: ${DRY_RUN ? 'dry-run (nothing dropped)' : `dropped ${dropped}`}/${candidates.length} candidate(s); ${failed.length} failed verify`,
  );
  if (failed.length) {
    // eslint-disable-next-line no-console
    console.error(
      `[delete-replay] FAILED verify — NOT dropped: ${failed.join(', ')}`,
    );
  }
  return failed.length;
}

main()
  .then((failedDays) => process.exit(failedDays > 0 ? 1 : 0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[delete-replay] FATAL', err);
    process.exit(1);
  });
