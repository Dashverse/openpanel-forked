import { TABLE_NAMES, ch, getReplicatedTableName } from '../clickhouse/client';
import { logger } from '../logger';
import { db } from '../prisma-client';

import sqlstring from 'sqlstring';

export async function deleteOrganization(organizationId: string) {
  return await db.organization.delete({
    where: {
      id: organizationId,
    },
  });
}

export async function deleteProjects(projectIds: string[]) {
  const projects = await db.project.findMany({
    where: {
      id: {
        in: projectIds,
      },
    },
  });

  if (projects.length === 0) {
    return;
  }

  for (const project of projects) {
    await db.project.delete({
      where: {
        id: project.id,
      },
    });
  }

  return projects;
}

/**
 * Every ClickHouse table that holds per-project rows (all have `project_id`).
 *
 * `mutation` picks the delete statement per table, explicitly:
 * - `'lightweight'` → `DELETE FROM …` (lightweight delete, cheap row mask).
 * - `'alter'` → `ALTER TABLE … DELETE` (a classic mutation). Required for
 *   materialized views (their storage forwards mutations to the inner table
 *   but does not support lightweight DELETE) and for any table that has a
 *   projection: the server runs with
 *   `lightweight_mutation_projection_mode = throw`, so a lightweight DELETE on
 *   a table with a projection fails on every run and the project would never
 *   get deleted. A mutation rewrites the projection parts too, so it works.
 *
 * `replicated: false` marks tables created by plain DDL outside the
 * createTable/createMaterializedView helpers, so they have no `_replicated`
 * companion in clustered mode and must be addressed by their plain name.
 */
export const CLICKHOUSE_PROJECT_TABLES: ReadonlyArray<{
  table: string;
  mutation: 'alter' | 'lightweight';
  replicated?: boolean;
}> = [
  { table: TABLE_NAMES.events, mutation: 'lightweight' },
  { table: TABLE_NAMES.profiles, mutation: 'lightweight' },
  { table: TABLE_NAMES.alias, mutation: 'lightweight' },
  { table: TABLE_NAMES.events_bots, mutation: 'lightweight' },
  { table: TABLE_NAMES.sessions, mutation: 'lightweight' },
  { table: TABLE_NAMES.events_imports, mutation: 'lightweight' },
  { table: TABLE_NAMES.cohort_members, mutation: 'lightweight' },
  { table: TABLE_NAMES.cohort_metadata, mutation: 'lightweight' },
  // TODO(replay blob cleanup): these rows (and replay_archive_index below)
  // only point at the replay payloads in Azure Blob; the blobs themselves are
  // not deleted here. Blobs are keyed by project/session, so a follow-up
  // cleanup job owned by the replay blob work can list and delete by the
  // project prefix.
  { table: TABLE_NAMES.session_replay_chunks, mutation: 'lightweight' },
  { table: TABLE_NAMES.session_replay_blocks, mutation: 'lightweight' },
  { table: TABLE_NAMES.dau_mv, mutation: 'alter' },
  { table: TABLE_NAMES.events_daily_stats, mutation: 'alter' },
  { table: TABLE_NAMES.event_names_mv, mutation: 'alter' },
  // Now a plain (Replicated)AggregatingMergeTree TABLE, not an MV, but it has
  // the `proj_event_keys` projection, so it MUST use ALTER … DELETE (see the
  // `lightweight_mutation_projection_mode = throw` note above). Verified on
  // prod: it is the only table in this list with a projection.
  { table: TABLE_NAMES.event_property_values_mv, mutation: 'alter' },
  // Created by plain DDL (archive CLI / migration 19), not the table helpers.
  {
    table: TABLE_NAMES.replay_archive_index,
    mutation: 'lightweight',
    replicated: false,
  },
  {
    table: TABLE_NAMES.device_first_seen,
    mutation: 'lightweight',
    replicated: false,
  },
  {
    table: TABLE_NAMES.first_event_dedup_device,
    mutation: 'lightweight',
    replicated: false,
  },
];

/** ClickHouse error code 60 = UNKNOWN_TABLE (table dropped or never created). */
export function isUnknownTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, type } = error as { code?: unknown; type?: unknown };
  return String(code) === '60' || type === 'UNKNOWN_TABLE';
}

/**
 * Delete every row belonging to `projectIds` from ClickHouse.
 *
 * Every table is attempted, even if an earlier one fails, so one bad table
 * can't keep the rest from being cleaned on each retry. A table that no longer
 * exists (UNKNOWN_TABLE) is logged and skipped. Any other failure is collected
 * and, after all tables were tried, thrown as one AggregateError naming the
 * failed tables, so the caller keeps the Postgres row and retries later.
 *
 * Deletes are submitted ASYNC (`lightweight_deletes_sync = 0`, overriding the
 * server default of 2, and `mutations_sync = 0`): the call returns once the
 * mutation is accepted and queued on the server, which then applies it in the
 * background. A sync wait on a big table like events could outlast the client
 * request timeout, and withRetry would then resend the delete.
 *
 * Idempotent: re-running it just re-issues the same `… WHERE project_id IN
 * (…)` deletes, so the hourly cron re-running after a failure is safe.
 */
export async function deleteFromClickhouse(projectIds: string[]) {
  if (projectIds.length === 0) {
    return;
  }

  const where = `project_id IN (${projectIds.map((projectId) => sqlstring.escape(projectId)).join(',')})`;
  const failures: { table: string; error: unknown }[] = [];

  for (const {
    table,
    mutation,
    replicated = true,
  } of CLICKHOUSE_PROJECT_TABLES) {
    const target = replicated ? getReplicatedTableName(table) : table;
    const query =
      mutation === 'alter'
        ? `ALTER TABLE ${target} DELETE WHERE ${where};`
        : `DELETE FROM ${target} WHERE ${where};`;

    logger.info('Deleting from ClickHouse table:', { query });
    try {
      await ch.command({
        query,
        clickhouse_settings:
          mutation === 'alter'
            ? { mutations_sync: '0' }
            : { lightweight_deletes_sync: '0' },
      });
    } catch (error) {
      if (isUnknownTableError(error)) {
        logger.warn('Skipping missing ClickHouse table during project delete', {
          table,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      logger.error('Failed to delete from ClickHouse table', {
        table,
        error: error instanceof Error ? error.message : String(error),
      });
      failures.push({ table, error });
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `ClickHouse project delete failed for ${failures.length} table(s): ${failures.map((f) => f.table).join(', ')}`,
    );
  }
}

/**
 * True once a project's scheduled deletion is due (`deleteAt <= now`), i.e.
 * the delete-projects cron may already have wiped its ClickHouse data. Past
 * that point the deletion can no longer be cancelled.
 */
export function isProjectDeletionDue(
  deleteAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  return !!deleteAt && deleteAt.getTime() <= now.getTime();
}
