/**
 * delete-archived-replay-chunks — verify-gated DROP of old `session_replay_chunks`
 * partitions from ClickHouse, once the day is safely archived to Azure Blob.
 * This is what actually reclaims CH hot storage; the Blob keeps the data forever.
 *
 * DRY-RUN BY DEFAULT — drops NOTHING unless REPLAY_DELETE_DRY_RUN='false'.
 *
 * For each day that is (a) `status='archived'` in `replay_archive_days`,
 * (b) older than RETAIN_DAYS, and (c) not already `deletedAt`, it RE-VERIFIES
 * FRESH with a ROW-COUNT reconciliation — the archive CATALOG
 * (replay_archive_index) must hold at least as many chunks as CH still has for
 * the day (idx >= ch) — and only then `DROP PARTITION` + stamps `deletedAt`.
 * Byte content is TRUSTED to the archive's own fail-loud write-time verify (it
 * reads the blobs back — count + sample — when it writes them and only marks a
 * day `archived` if that passes). We do NOT re-read the blobs here: reading a
 * whole day back decompresses every payload block and OOMs on large sessions,
 * and the archive + zstd + Azure checksums already protect the bytes. Accepted
 * residual: a blob silently corrupted/deleted AFTER archival, which this count
 * gate can't see. A day that fails the count check is skipped, marked
 * `verify_failed`, exits non-zero. The `archived` flag only picks candidates.
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
const TABLE = 'session_replay_chunks';
const INDEX = 'replay_archive_index';

function int(key: string, def: number): number {
  const v = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}
// Keep this many days hot in CH; delete strictly older ones.
const RETAIN_DAYS = int('REPLAY_DELETE_RETAIN_DAYS', 30);
const MAX_DAYS_PER_RUN = int('REPLAY_DELETE_MAX_DAYS_PER_RUN', 5);
const MAX_EXEC_SEC = int('REPLAY_DELETE_MAX_EXEC_SEC', 1800);
// SAFETY DEFAULT: drops nothing unless explicitly set to the string 'false'.
const DRY_RUN = process.env.REPLAY_DELETE_DRY_RUN !== 'false';

// The verify is two cheap COUNT queries (CH partition + archive catalog) with no
// blob read, so it needs no memory/thread caps.
const SETTINGS: ClickHouseSettings = {
  max_execution_time: MAX_EXEC_SEC,
};

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[delete-replay] ${msg}`);
}

type VerifyResult = {
  ok: boolean;
  empty?: boolean; // 0 chunks already in CH — nothing to drop, benign skip
  idxN: number; // replay_archive_index (catalog) chunk count for the day
  srcN: number; // CH chunk count for the day
  reason?: string;
};

/**
 * Re-verify a day immediately before dropping it, by ROW-COUNT reconciliation
 * against the archive CATALOG (replay_archive_index): the catalog must hold at
 * least as many chunks as ClickHouse still has for the day (idx >= ch).
 *
 * We do NOT re-read the blobs here. Byte content is trusted to the archive's own
 * fail-loud write-time verify (it reads the blobs back — count + sample — when
 * it writes them, and only marks a day `archived` if that passes, exiting
 * non-zero otherwise); zstd and Azure add their own checksums on top. Reading a
 * whole day back at delete time decompresses every payload block and OOMs on
 * large sessions, so the count gate is the deliberate, cheap trade. Accepted
 * residual: a blob silently corrupted/deleted AFTER archival is not detected
 * here. The stored `archived` status only picks candidates; this fresh count is
 * the gate.
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
    // Catalog recorded fewer chunks than CH still holds → the archive is
    // incomplete for this day. Never drop it.
    return {
      ok: false,
      idxN,
      srcN,
      reason: `archive INCOMPLETE: catalog=${idxN} < ch=${srcN}`,
    };
  }
  log(`  verify ${dayStr}: ch=${srcN} catalog=${idxN} — count OK (catalog >= ch)`);
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
    `start dryRun=${DRY_RUN} retainDays=${RETAIN_DAYS} (delete days < ${cutoffStr}) maxDays=${MAX_DAYS_PER_RUN} verify=row-count(catalog>=ch)`,
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
      // Only mutate the ledger on a real run — a dry-run stays read-only. A
      // verify_failed day drops out of listDeletableDays, so a dry-run must not
      // be able to change which days a later real run will consider.
      if (!DRY_RUN) {
        await markVerifyFailed(dayStr, `delete verify failed: ${v.reason}`, {
          chChunks: v.srcN,
          blobChunks: v.idxN,
        }).catch((e) => log(`  WARN: status write failed: ${String(e)}`));
      }
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
