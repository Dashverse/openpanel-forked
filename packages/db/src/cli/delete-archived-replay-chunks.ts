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
const VERIFY_SAMPLE = int('REPLAY_DELETE_VERIFY_SAMPLE', 5);
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

type Sample = { session_id: string; project_id: string; blob_path: string };
type VerifyResult = {
  ok: boolean;
  empty?: boolean; // 0 chunks already in CH — nothing to drop, benign skip
  idxN: number;
  srcN: number;
  reason?: string;
};

// Content fingerprint over the two data columns that always exist. sum() is
// order-independent, so CH-order vs Blob-order doesn't matter — only the bytes.
const FP = 'sum(cityHash64(chunk_index, payload)) AS fp';

/**
 * Re-verify a day FRESH, immediately before dropping it: index >= CH count, then
 * a content fingerprint on VERIFY_SAMPLE sessions (CH bytes == Blob bytes). This
 * runs at delete time — the stored `archived` status is only used to pick
 * candidates, never as proof.
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
  if (idxN < srcN) {
    return { ok: false, idxN, srcN, reason: `blob INCOMPLETE: index=${idxN} < ch=${srcN}` };
  }
  const samples = await chQuery<Sample>(
    `SELECT session_id, project_id, blob_path FROM ${INDEX} FINAL
      WHERE dt = toDate('${dayStr}') AND chunks > 0
      ORDER BY chunks ASC LIMIT ${VERIFY_SAMPLE}`,
    SETTINGS,
  );
  if (samples.length === 0) {
    return { ok: false, idxN, srcN, reason: 'no indexed sessions to fingerprint' };
  }
  for (const s of samples) {
    const [chRow] = await chQuery<{ fp: string }>(
      `SELECT ${FP} FROM ${TABLE}
        WHERE toYYYYMMDD(started_at) = ${dayInt}
          AND project_id = '${esc(s.project_id)}'
          AND session_id = '${esc(s.session_id)}'`,
      SETTINGS,
    );
    const [blobRow] = await chQuery<{ fp: string }>(
      `SELECT ${FP} FROM azureBlobStorage(
         '${CONN}', '${CONTAINER}', '${esc(s.blob_path)}', '${FORMAT}', '${COMPRESSION}')`,
      SETTINGS,
    );
    if (chRow?.fp == null || String(chRow.fp) !== String(blobRow?.fp)) {
      return {
        ok: false,
        idxN,
        srcN,
        reason: `fingerprint MISMATCH session=${s.session_id} ch=${chRow?.fp} blob=${blobRow?.fp}`,
      };
    }
  }
  log(
    `  verify ${dayStr}: index=${idxN} ch=${srcN} OK (+${samples.length} content-fingerprint samples)`,
  );
  return { ok: true, idxN, srcN };
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
    `start dryRun=${DRY_RUN} retainDays=${RETAIN_DAYS} (delete days < ${cutoffStr}) maxDays=${MAX_DAYS_PER_RUN} sample=${VERIFY_SAMPLE}`,
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
      log(`  skip ${dayStr}: CH partition already empty (0 chunks)`);
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
