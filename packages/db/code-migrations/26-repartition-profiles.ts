import { runClickhouseMigrationCommands } from '../src/clickhouse/migration';

/**
 * Repartition `profiles` from `toYYYYMM(created_at)` to `project_id`.
 *
 * WHY: `profiles` is `ReplacingMergeTree(created_at)` ORDER BY (project_id, id)
 * PARTITION BY toYYYYMM(created_at). `created_at` is therefore BOTH the version
 * AND the partition key — and profile-buffer rewrites it on every upsert
 * (`created_at: formatClickhouseDate(new Date())`). Two consequences:
 *
 *  1. DEDUP IS BROKEN. ReplacingMergeTree only collapses duplicates WITHIN a
 *     partition. An update moves the row to a different month, so a profile's
 *     versions scatter and can never be merged away. Measured on prod: of the
 *     ids with >1 version, 16.5% spanned >1 monthly partition; the rebuild took
 *     the table from 129.22M to 115.66M rows (~13.5M undedupable rows, ~10%).
 *
 *  2. POINT LOOKUPS SCAN EVERY PARTITION. The ingest-path lookup
 *     (`WHERE project_id = ? AND id = ?`) has no date predicate, so every
 *     monthly partition is a candidate and ClickHouse reads ~1 granule per
 *     candidate part: cost = parts × 8192, growing every month. Measured on
 *     prod, one profile: 92 parts / 584,537 rows / 100.3ms CPU on the old
 *     schema vs 12 parts / 97,708 rows / 30.3ms CPU after. During a backend job
 *     that woke ~100K dormant users in ~30min these lookups were 66-77% of ALL
 *     ClickHouse query CPU and exhausted max_concurrent_queries_for_user.
 *
 * `project_id` is stable for a row (so dedup works) and is the first sort-key
 * column (so a lookup prunes to one partition). Upstream issue:
 * https://github.com/Openpanel-dev/openpanel/issues/508
 *
 * WHY EXCHANGE AND NOT DROP+RENAME: EXCHANGE TABLES is atomic and keeps the
 * live name, so there is no application change, no read/write gap, and the old
 * table survives as `profiles_v2` for an instant rollback (run the same
 * EXCHANGE again). Writes follow the NAME, so the instant the swap lands they
 * go to the new table and the old one is frozen — which is why a plain delta
 * copy afterwards is sufficient and no dual-write MV is needed.
 *
 * COST (prod, 129M rows / 9.94 GiB compressed / 45 GiB uncompressed): 5m19s
 * total, 17-47s per partition, cluster CPU roughly doubled for the ~12s each
 * partition ran, zero rejected queries, live traffic unaffected.
 *
 * NOT IN THIS MIGRATION (deliberate, see the runbook in the PR):
 *   - the EXCHANGE itself and the post-swap delta copy. Both are one-liners but
 *     they flip production, so they stay a human step:
 *       EXCHANGE TABLES profiles AND profiles_v2;
 *       INSERT INTO profiles SELECT * FROM profiles_v2 WHERE created_at >= '<T0>';
 *     (<T0> = the timestamp printed before the backfill started. Overlap is
 *     harmless — duplicates now share a partition, so they collapse.)
 *   - dropping the old table. Keep it a few days as rollback.
 *
 * GATE before swapping: benchmark a real id against profiles_v2 and confirm
 * SelectedParts drops from ~90 to ~10-15. If it doesn't, stop.
 *
 * Aiven note (same as migrations 19 and 23): plain DDL (no ON CLUSTER)
 * auto-converts to Replicated* and propagates to all replicas.
 */

const TARGET = 'profiles_v2';

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS ${TARGET}
(
    \`id\` String CODEC(ZSTD(3)),
    \`is_external\` Bool,
    \`first_name\` String CODEC(ZSTD(3)),
    \`last_name\` String CODEC(ZSTD(3)),
    \`email\` String CODEC(ZSTD(3)),
    \`avatar\` String CODEC(ZSTD(3)),
    \`properties\` Map(String, String) CODEC(ZSTD(3)),
    \`project_id\` String CODEC(ZSTD(3)),
    \`created_at\` DateTime64(3) CODEC(Delta(4), LZ4),
    \`os\` String MATERIALIZED properties['os'],
    \`campaign\` String MATERIALIZED properties['campaign'],
    \`quotaPlan\` String MATERIALIZED properties['quotaPlan'],
    INDEX idx_first_name first_name TYPE bloom_filter GRANULARITY 1,
    INDEX idx_last_name last_name TYPE bloom_filter GRANULARITY 1,
    INDEX idx_email email TYPE bloom_filter GRANULARITY 1
)
ENGINE = ReplacingMergeTree(created_at)
PARTITION BY project_id
ORDER BY (project_id, id)
SETTINGS index_granularity = 8192`,
];

export async function up() {
  // T0 — every row written to `profiles` from here on is NOT covered by the
  // backfill below and must be picked up by the post-swap delta copy.
  const t0 = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[26] T0 = ${t0} (UTC) — use this for the post-swap delta copy`);

  await runClickhouseMigrationCommands(DDL);

  // Backfill one partition at a time: bounded memory (~2.8 GiB peak at
  // max_threads=2) and resumable — a failed partition can be re-run on its own,
  // and re-running a completed one is harmless because the duplicates collapse.
  // `SELECT *` deliberately: MATERIALIZED columns are skipped by `*` and
  // recomputed on insert, so the column lists must stay identical.
  const partitions = await getSourcePartitions();
  console.log(`[26] backfilling ${partitions.length} partitions`);

  for (const partition of partitions) {
    const started = Date.now();
    await runClickhouseMigrationCommands([
      `INSERT INTO ${TARGET}
       SELECT * FROM profiles
       WHERE _partition_id = '${partition}'
       SETTINGS max_threads = 2, max_insert_threads = 2`,
    ]);
    console.log(
      `[26]   ${partition} -> ${Math.round((Date.now() - started) / 1000)}s`,
    );
  }

  console.log(
    [
      '[26] backfill done. NEXT (manual, after verifying):',
      '  1. benchmark a real id on profiles_v2 — SelectedParts should be ~10-15, not ~90',
      '  2. compare uniqExact(id) per project between profiles and profiles_v2 (must match)',
      "  3. EXCHANGE TABLES profiles AND profiles_v2;",
      `  4. INSERT INTO profiles SELECT * FROM profiles_v2 WHERE created_at >= '${t0}';`,
      '  5. soak a few days, then DROP TABLE profiles_v2',
    ].join('\n'),
  );
}

async function getSourcePartitions(): Promise<string[]> {
  const { chQuery } = await import('../src/clickhouse/client');
  const rows = await chQuery<{ partition_id: string }>(
    `SELECT DISTINCT partition_id
     FROM system.parts
     WHERE table = 'profiles' AND active
     ORDER BY partition_id`,
  );
  return rows.map((r) => r.partition_id);
}
