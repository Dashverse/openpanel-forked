/**
 * 25-add-session-replay-blocks
 *
 * Phase 2 of the session-replay storage move: blob-primary. The raw replay bytes
 * live in Azure Blob as zstd blocks (one append-blob per session); ClickHouse
 * keeps only a byte-range REFERENCE per block so the player can range-GET exactly
 * the bytes a session (or time window) needs — no payload in CH.
 *
 * `session_replay_blocks` is the byte-range index. One row per block:
 *   - blob_path            which Azure blob holds the bytes
 *   - [byte_start, byte_end)  the range to GET (exclusive end)
 *   - [chunk_lo, chunk_hi]    which replay chunk_indexes the block covers
 *   - first/last_started_at   time span, for window seeks + list/duration
 *
 * ReplacingMergeTree(created_at): a re-delivered Kafka batch (at-least-once) that
 * re-writes the same (project, session, block_index) collapses on merge; serving
 * also de-dups chunks by (chunk_index, started_at), so duplicates are inert.
 *
 * No TTL: refs must live as long as the blob they point at (blobs are retained).
 */
import fs from 'node:fs';
import path from 'node:path';
import { TABLE_NAMES } from '../src/clickhouse/client';
import {
  createTable,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

export async function up() {
  const isClustered = getIsCluster();

  const sqls: string[] = [
    ...createTable({
      name: TABLE_NAMES.session_replay_blocks,
      columns: [
        '`project_id` String CODEC(ZSTD(3))',
        '`session_id` String CODEC(ZSTD(3))',
        "`window_id` String DEFAULT '' CODEC(ZSTD(3))",
        '`block_index` UInt64',
        '`blob_path` String CODEC(ZSTD(3))',
        '`byte_start` UInt64',
        '`byte_end` UInt64',
        '`chunk_lo` UInt16',
        '`chunk_hi` UInt16',
        '`first_started_at` DateTime64(3) CODEC(DoubleDelta, ZSTD(3))',
        '`last_started_at` DateTime64(3) CODEC(DoubleDelta, ZSTD(3))',
        '`events_count` UInt32',
        '`size_bytes` UInt64',
        "`codec` LowCardinality(String) DEFAULT 'zstd'",
        '`created_at` DateTime DEFAULT now()',
      ],
      engine: 'ReplacingMergeTree(created_at)',
      orderBy: ['project_id', 'session_id', 'block_index'],
      partitionBy: 'toYYYYMMDD(first_started_at)',
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
