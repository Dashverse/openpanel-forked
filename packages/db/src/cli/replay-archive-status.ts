/**
 * Print the session-replay archive status table (Postgres `replay_archive_days`).
 * Read-only — no ClickHouse, no Blob, nothing dropped.
 *
 *   pnpm --filter @openpanel/db status:replay
 */
import { listArchiveDays } from '../services/replay-archive-day.service';

const ts = (d: Date | null): string =>
  d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—';
const ymd = (d: Date): string => new Date(d).toISOString().slice(0, 10);

async function main(): Promise<void> {
  const days = await listArchiveDays();
  if (days.length === 0) {
    // eslint-disable-next-line no-console
    console.log('replay_archive_days is empty — run archive:replay first.');
    return;
  }

  const cols = [
    'day'.padEnd(10),
    'status'.padEnd(13),
    'ch'.padStart(10),
    'blob'.padStart(10),
    'drift'.padStart(6),
    'sessions'.padStart(8),
    'verifiedAt'.padEnd(16),
    'error',
  ].join('  ');
  // eslint-disable-next-line no-console
  console.log(cols);
  for (const r of days) {
    // eslint-disable-next-line no-console
    console.log(
      [
        ymd(r.day).padEnd(10),
        r.status.padEnd(13),
        (r.chChunks?.toString() ?? '—').padStart(10),
        (r.blobChunks?.toString() ?? '—').padStart(10),
        String(r.driftChunks ?? 0).padStart(6),
        String(r.sessions ?? '—').padStart(8),
        ts(r.verifiedAt).padEnd(16),
        r.verifyError ?? '',
      ].join('  '),
    );
  }

  const by = (s: string): number => days.filter((d) => d.status === s).length;
  // eslint-disable-next-line no-console
  console.log(
    `\n${days.length} day(s): archived=${by('archived')} pending=${by('pending')} archiving=${by('archiving')} verify_failed=${by('verify_failed')}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[status:replay]', err);
    process.exit(1);
  });
