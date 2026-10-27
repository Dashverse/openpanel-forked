import fs from 'node:fs';
import path from 'node:path';
import { TABLE_NAMES } from '../src/clickhouse/client';
import {
  addColumns,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

/**
 * 26-add-chunk-keys-to-replay-blocks
 *
 * Adds `chunk_keys` to session_replay_blocks: the payload-free key of every
 * chunk inside the block, one tuple per NDJSON line -
 *   (chunk_index, started_ms, ended_ms, is_full_snapshot)
 * with started_ms / ended_ms = the chunk's started_at / ended_at as Unix ms
 * (the same values `toUnixTimestamp64Milli` gives on session_replay_chunks).
 *
 * With it, the serving path builds a session's ordered chunk index (seq,
 * full-snapshot anchors, windows, segments, duration) from the refs alone and
 * range-GETs only the blocks a page needs. Refs written before this column
 * existed keep the DEFAULT empty array; the reader derives their keys by
 * decoding the block (cached), so the column is an optimisation, not a
 * requirement for correctness.
 *
 * Unnamed tuple on purpose: JSONEachRow reads/writes it as a plain JSON array
 * (`[[0,1760000000000,1760000000500,1], …]`) regardless of the
 * named-tuples-as-objects settings.
 */
export async function up() {
  const isClustered = getIsCluster();

  const sqls: string[] = [
    ...addColumns(
      TABLE_NAMES.session_replay_blocks,
      [
        '`chunk_keys` Array(Tuple(UInt32, Int64, Int64, UInt8)) DEFAULT [] CODEC(ZSTD(3)) AFTER `codec`',
      ],
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
