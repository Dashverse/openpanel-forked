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
 * `mutation: 'alter'` → `ALTER TABLE … DELETE` (required for materialized
 * views, whose storage forwards mutations to the inner table but does not
 * support lightweight DELETE, and for tables with projections).
 * `mutation: 'lightweight'` → `DELETE FROM …`.
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
  { table: TABLE_NAMES.session_replay_chunks, mutation: 'lightweight' },
  { table: TABLE_NAMES.session_replay_blocks, mutation: 'lightweight' },
  { table: TABLE_NAMES.dau_mv, mutation: 'alter' },
  { table: TABLE_NAMES.events_daily_stats, mutation: 'alter' },
  { table: TABLE_NAMES.event_names_mv, mutation: 'alter' },
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
 * Idempotent: re-running it just re-issues the same `DELETE … WHERE
 * project_id IN (…)` mutations, so callers can retry after a failure.
 *
 * A table that no longer exists (UNKNOWN_TABLE) is logged and skipped so one
 * dropped table can't stop the rest from being cleaned. Any other error is
 * rethrown so the caller keeps the Postgres row and retries later.
 */
export async function deleteFromClickhouse(projectIds: string[]) {
  if (projectIds.length === 0) {
    return;
  }

  const where = `project_id IN (${projectIds.map((projectId) => sqlstring.escape(projectId)).join(',')})`;

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
        clickhouse_settings: {
          lightweight_deletes_sync: '0',
        },
      });
    } catch (error) {
      if (isUnknownTableError(error)) {
        logger.warn('Skipping missing ClickHouse table during project delete', {
          table,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      throw error;
    }
  }
}
