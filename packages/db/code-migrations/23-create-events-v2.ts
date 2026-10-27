/**
 * Stage 1 of the events_v2 sort-key migration (#401): RETIRED, now a no-op.
 *
 * This used to CREATE the `events_v2` scaffold with the name-first sort key
 * `ORDER BY (project_id, toDate(created_at), name, cityHash64(profile_id), created_at)`.
 * That migration is finished: in 2026-08 `events_v2` was swapped in with
 * EXCHANGE TABLES (so `events` is now the name-first table on prod) and the
 * leftover table was dropped. No code reads `events_v2` any more, so creating
 * it on a fresh install would only add an empty, unused table.
 *
 * The file and the `up` export stay because the migration runner records
 * migrations by file name: installs that already ran 23 keep a matching record,
 * and new installs record it without creating anything.
 */

export async function up() {
  console.log(
    '[23-create-events-v2] No-op: events_v2 was exchanged into `events` and dropped in 2026-08; nothing reads it, so it is no longer created.',
  );
}

export async function down() {
  console.log('[23-create-events-v2] No-op: nothing to undo.');
}
