/**
 * Per-day status/audit for the session-replay CH→Azure-Blob archive.
 *
 * Written by src/cli/archive-replay-chunks.ts. Purely observational — nothing
 * here drops CH partitions or gates archival. All writes are best-effort at the
 * call sites (a Postgres hiccup must never fail an archive run), so these just
 * do the upsert.
 */
import { db } from '../prisma-client';

export type ReplayDayStatus =
  | 'pending'
  | 'archiving'
  | 'archived'
  | 'verify_failed';

/** Parse a 'YYYY-MM-DD' day string to a UTC midnight Date for the @db.Date PK. */
function toDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * Reconcile a settled day's status from counts alone (no blob sample):
 * blob >= ch → 'archived' (with any benign superset as driftChunks); otherwise
 * 'pending'. Never touches verifiedAt (that needs the full verify) — so a day
 * can be 'archived' by count yet not freshly sampled. archivedAt is stamped the
 * first time it is count-complete and preserved after. Does not override an
 * in-flight 'archiving' or a 'verify_failed' set earlier in the same run.
 */
export async function reconcileArchiveDay(
  day: string,
  chChunks: number,
  blobChunks: number,
): Promise<void> {
  const drift = blobChunks - chChunks;
  const complete = chChunks > 0 && blobChunks >= chChunks;
  const status: ReplayDayStatus = complete ? 'archived' : 'pending';
  const now = new Date();
  await db.replayArchiveDay.upsert({
    where: { day: toDay(day) },
    create: {
      day: toDay(day),
      status,
      chChunks: BigInt(chChunks),
      blobChunks: BigInt(blobChunks),
      driftChunks: drift > 0 ? drift : 0,
      archivedAt: complete ? now : null,
      lastRunAt: now,
    },
    update: {
      status,
      chChunks: BigInt(chChunks),
      blobChunks: BigInt(blobChunks),
      driftChunks: drift > 0 ? drift : 0,
      lastRunAt: now,
      // archivedAt intentionally not updated here; stamped once below if null.
    },
  });
  // Stamp archivedAt the first time a day goes complete, without overwriting an
  // existing value ("set only if null" isn't expressible in a single upsert).
  if (complete) {
    await db.replayArchiveDay.updateMany({
      where: { day: toDay(day), archivedAt: null },
      data: { archivedAt: now },
    });
  }
}

/** Mark a day as actively being (re)archived this run. */
export async function markArchiving(day: string): Promise<void> {
  const now = new Date();
  await db.replayArchiveDay.upsert({
    where: { day: toDay(day) },
    create: { day: toDay(day), status: 'archiving', lastRunAt: now },
    update: { status: 'archiving', lastRunAt: now },
  });
}

/** Mark a day fully archived AND verified (count matched + blob sample passed). */
export async function markVerified(
  day: string,
  chChunks: number,
  blobChunks: number,
  sessions: number,
): Promise<void> {
  const drift = blobChunks - chChunks;
  const now = new Date();
  const data = {
    status: 'archived' as ReplayDayStatus,
    chChunks: BigInt(chChunks),
    blobChunks: BigInt(blobChunks),
    driftChunks: drift > 0 ? drift : 0,
    sessions,
    verifiedAt: now,
    verifyError: null,
    lastRunAt: now,
  };
  await db.replayArchiveDay.upsert({
    where: { day: toDay(day) },
    create: { day: toDay(day), archivedAt: now, ...data },
    update: data,
  });
  await db.replayArchiveDay.updateMany({
    where: { day: toDay(day), archivedAt: null },
    data: { archivedAt: now },
  });
}

/**
 * Mark a day whose archival is incomplete / failed verification. Counts are
 * optional: pass them for a real verify mismatch; omit them for an export throw
 * (no reliable counts) so we don't clobber a previously-recorded real count.
 */
export async function markVerifyFailed(
  day: string,
  error: string,
  counts?: { chChunks: number; blobChunks: number },
): Promise<void> {
  const now = new Date();
  const data = {
    status: 'verify_failed' as ReplayDayStatus,
    verifyError: error,
    lastRunAt: now,
    ...(counts
      ? {
          chChunks: BigInt(counts.chChunks),
          blobChunks: BigInt(counts.blobChunks),
        }
      : {}),
  };
  await db.replayArchiveDay.upsert({
    where: { day: toDay(day) },
    create: { day: toDay(day), ...data },
    update: data,
  });
}

/** All tracked days, newest first — for the status:replay report CLI. */
export function listArchiveDays() {
  return db.replayArchiveDay.findMany({ orderBy: { day: 'desc' } });
}
