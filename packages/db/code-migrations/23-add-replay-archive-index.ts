import fs from 'node:fs';
import path from 'node:path';
import { TABLE_NAMES } from '../src/clickhouse/client';
import {
  createTable,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

/**
 * Creates `replay_archive_index` — the locator that maps an archived session to
 * its Parquet object in Azure Blob. Written by `pnpm archive:replay`
 * (src/cli/archive-replay-chunks.ts) and read by the dashboard's
 * archived-replay serving path.
 *
 * Notes:
 *  - `dt` is IN the ORDER BY so a session that crosses midnight (chunks land in
 *    two daily partitions → two archive files) keeps BOTH pointers instead of
 *    one row overwriting the other.
 *  - `ReplacingMergeTree(archived_at)` makes re-archival idempotent (a retried
 *    day replaces its rows rather than duplicating them).
 *  - NO TTL — this index must outlive the `session_replay_chunks` hot window;
 *    it's the only locator once a day ages out of ClickHouse.
 *  - `blob_path` is deterministic: dt=<date>/project_id=<p>/bucket=<hash>.parquet.
 */
export async function up() {
  const isClustered = getIsCluster();

  const sqls: string[] = [
    ...createTable({
      name: TABLE_NAMES.replay_archive_index,
      columns: [
        '`project_id` String',
        '`session_id` String',
        "`profile_id` String DEFAULT ''",
        '`dt` Date',
        '`blob_path` String',
        '`chunks` UInt32',
        '`first_started_at` DateTime64(3)',
        '`last_started_at` DateTime64(3)',
        '`archived_at` DateTime DEFAULT now()',
      ],
      orderBy: ['project_id', 'session_id', 'dt'],
      engine: 'ReplacingMergeTree(archived_at)',
      settings: {
        index_granularity: 8192,
      },
      distributionHash: 'cityHash64(project_id, session_id)',
      replicatedVersion: '1',
      isClustered,
    }),
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
