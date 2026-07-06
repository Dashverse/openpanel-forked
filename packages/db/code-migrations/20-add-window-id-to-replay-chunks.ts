import fs from 'node:fs';
import path from 'node:path';
import { TABLE_NAMES } from '../src/clickhouse/client';
import {
  addColumns,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

/**
 * Adds `window_id` to session_replay_chunks.
 *
 * window_id is a client-generated per-tab / per-page-load UUID. It lets the
 * player distinguish chunks from multiple recorders that share the same
 * session_id (multiple tabs open, or a page refresh spawning a fresh
 * recorder). Without it, those recorders collide on chunk_index and the
 * dashboard can't reconstruct a coherent timeline.
 *
 * Defaults to '' so existing rows and older-SDK chunks (which don't send a
 * window_id) remain valid — the ReplayBuffer streams raw JSONEachRow, and a
 * missing field falls back to the column DEFAULT.
 *
 * NOTE: we intentionally do NOT change the table's ORDER BY. Same-session_id
 * multi-recorder rows were already possible before this column existed; the
 * fix is at read time (filter/group by window_id), not in the sort key.
 */
export async function up() {
  const isClustered = getIsCluster();

  const sqls: string[] = [
    ...addColumns(
      TABLE_NAMES.session_replay_chunks,
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
