import fs from 'node:fs';
import path from 'node:path';
import { TABLE_NAMES } from '../src/clickhouse/client';
import {
  addColumns,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

/**
 * Adds `window_id` to events.
 *
 * window_id is a client-generated per-tab / per-page-load UUID. The web SDK
 * (>=1.4.1) already sends it on every event alongside session_id, but it was
 * being dropped because the events table had no column for it.
 *
 * Storing it lets the dashboard map an event to the EXACT recording (tab /
 * window) it happened in. A session_id can span multiple concurrent windows,
 * so session_id alone is ambiguous — window_id makes event -> replay a clean
 * 1:1 lookup instead of a timestamp heuristic.
 *
 * Defaults to '' so existing rows and older-SDK events (which don't send a
 * window_id) remain valid — the EventBuffer streams JSONEachRow, and a missing
 * field falls back to the column DEFAULT.
 */
export async function up() {
  const isClustered = getIsCluster();

  const sqls: string[] = [
    ...addColumns(
      TABLE_NAMES.events,
      ["`window_id` String DEFAULT '' CODEC(ZSTD(3)) AFTER `session_id`"],
      isClustered,
    ),
  ];

  fs.writeFileSync(
    path.join(__filename.replace('.ts', '.sql')),
    sqls
      .map((sql) =>
        sql
          .trim()
          .replace(/;$/, '')
          .replace(/\n{2,}/g, '\n')
          .concat(';'),
      )
      .join('\n\n---\n\n'),
  );

  if (!process.argv.includes('--dry')) {
    await runClickhouseMigrationCommands(sqls);
  }
}
