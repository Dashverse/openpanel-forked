import { runClickhouseMigrationCommands } from '../src/clickhouse/migration';

/**
 * Stage 1 — CREATE the `events_v2` table (empty scaffold only).
 *
 * WHY: `events` is sorted `ORDER BY (project_id, toDate(created_at), created_at, name)`.
 * Because microsecond-unique `created_at` sits BEFORE `name`, the primary index can
 * never prune by event name — every name-filtered query (≈90% of the workload) scans
 * the whole day. See docs/events-orderby-decision.md for the full evidence.
 *
 * `events_v2` fixes the sort key:
 *     ORDER BY (project_id, toDate(created_at), name, cityHash64(profile_id), created_at)
 *     SAMPLE BY cityHash64(profile_id)
 *   - `name` 3rd            → name filters prune on the primary index (no full-day scan)
 *   - `cityHash64(profile_id)` 4th → per-profile rows cluster → streaming funnel/journey
 *     aggregation instead of RAM-buffered (also the SAMPLE BY key)
 *   - `created_at` last     → high-uniqueness tie-breaker (no separate uuid/id needed)
 *
 * Schema is an EXACT mirror of `events` (all ordinary + materialized columns, codecs,
 * skip indexes) with TWO deliberate differences:
 *   1. proj_funnel projection is DROPPED — the name-first key makes it redundant; keeping
 *      it would just re-pay the 2× write + ~1.17 TiB storage for no benefit.
 *   2. `windowId` column ADDED (MATERIALIZED from properties['windowId'], '' today) — ready
 *      for future window/tab-level journey analysis without a later ALTER.
 *      NOTE: modelled as MATERIALIZED-from-properties so the Stage-2 dual-write /
 *      backfill can stay a plain `INSERT ... SELECT * FROM events` (materialized columns
 *      are skipped in SELECT * and recomputed on insert — no column-count mismatch).
 *      If windowId later becomes a first-class TOP-LEVEL ingested field, switch it to an
 *      ordinary column and make the dual-write use an explicit column list.
 *
 * Aiven note (same as migration 19): plain DDL (no ON CLUSTER) auto-converts to
 * Replicated* and propagates to all replicas here.
 *
 * DELIBERATELY NOT in this migration (each is a separate, gated step):
 *   - the dual-write MV `events_to_v2` (touches the live ingest path)
 *   - the day-by-day backfill (~170M rows/day)
 *   - the EXCHANGE TABLES cutover
 * Gate before any backfill: build ONE day into events_v2 and benchmark the key
 * (Inv 7) against events before committing the full ~6.4 TiB rebuild.
 */

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS events_v2
(
    \`id\` UUID DEFAULT generateUUIDv4(),
    \`name\` LowCardinality(String),
    \`sdk_name\` LowCardinality(String),
    \`sdk_version\` LowCardinality(String),
    \`device_id\` String CODEC(ZSTD(3)),
    \`profile_id\` String CODEC(ZSTD(3)),
    \`project_id\` String CODEC(ZSTD(3)),
    \`session_id\` String CODEC(LZ4),
    \`path\` String CODEC(ZSTD(3)),
    \`origin\` String CODEC(ZSTD(3)),
    \`referrer\` String CODEC(ZSTD(3)),
    \`referrer_name\` String CODEC(ZSTD(3)),
    \`referrer_type\` LowCardinality(String),
    \`revenue\` UInt64,
    \`duration\` UInt64 CODEC(Delta(4), LZ4),
    \`properties\` Map(String, String) CODEC(ZSTD(3)),
    \`created_at\` DateTime64(3) CODEC(DoubleDelta, ZSTD(3)),
    \`country\` LowCardinality(FixedString(2)),
    \`city\` String,
    \`region\` LowCardinality(String),
    \`longitude\` Nullable(Float32) CODEC(Gorilla(4), LZ4),
    \`latitude\` Nullable(Float32) CODEC(Gorilla(4), LZ4),
    \`os\` LowCardinality(String),
    \`os_version\` LowCardinality(String),
    \`browser\` LowCardinality(String),
    \`browser_version\` LowCardinality(String),
    \`device\` LowCardinality(String),
    \`brand\` LowCardinality(String),
    \`model\` LowCardinality(String),
    \`imported_at\` Nullable(DateTime) CODEC(Delta(4), LZ4),
    -- NEW: window/tab id for future journey analysis (empty '' until ingested)
    \`windowId\` String MATERIALIZED ifNull(properties['windowId'], ''),
    -- materialized property columns (exact mirror of events)
    \`searchType\` LowCardinality(String) MATERIALIZED ifNull(properties['searchType'], ''),
    \`source\` LowCardinality(String) MATERIALIZED ifNull(properties['source'], ''),
    \`sourceShowName\` LowCardinality(String) MATERIALIZED ifNull(properties['sourceShowName'], ''),
    \`action\` LowCardinality(String) MATERIALIZED ifNull(properties['action'], ''),
    \`showName\` LowCardinality(String) MATERIALIZED ifNull(properties['showName'], ''),
    \`isExplore\` LowCardinality(String) MATERIALIZED ifNull(properties['isExplore'], ''),
    \`$os\` String MATERIALIZED properties['$os'],
    \`language\` String MATERIALIZED properties['language'],
    \`status\` String MATERIALIZED properties['status'],
    \`type\` String MATERIALIZED properties['type'],
    \`flow\` String MATERIALIZED properties['flow'],
    \`notificationPermissionStatus\` String MATERIALIZED properties['notificationPermissionStatus'],
    \`dialogName\` String MATERIALIZED properties['dialogName'],
    \`screenName\` String MATERIALIZED properties['screenName'],
    \`resultCount\` String MATERIALIZED properties['resultCount'],
    \`af_adset_id\` String MATERIALIZED properties['af_adset_id'],
    \`mp_lib\` String MATERIALIZED properties['mp_lib'],
    \`isEligibleForTrial\` String MATERIALIZED properties['isEligibleForTrial'],
    \`refundAmount\` String MATERIALIZED properties['refundAmount'],
    \`amount\` String MATERIALIZED properties['amount'],
    \`messageType\` String MATERIALIZED properties['messageType'],
    \`period_type\` String MATERIALIZED properties['period_type'],
    \`trigger\` String MATERIALIZED properties['trigger'],
    \`toLanguage\` String MATERIALIZED properties['toLanguage'],
    \`subscription-v3-enabled\` String MATERIALIZED properties['subscription-v3-enabled'],
    \`productId\` String MATERIALIZED properties['productId'],
    \`multi-trial-experiment\` String MATERIALIZED properties['multi-trial-experiment'],
    \`shortfree-ad-frequency\` String MATERIALIZED properties['shortfree-ad-frequency'],
    \`errorCode\` String MATERIALIZED properties['errorCode'],
    \`af_adset\` String MATERIALIZED properties['af_adset'],
    \`reason\` String MATERIALIZED properties['reason'],
    \`paymentGateway\` String MATERIALIZED properties['paymentGateway'],
    \`showId\` LowCardinality(String) MATERIALIZED ifNull(properties['showId'], ''),
    \`job_type\` String MATERIALIZED properties['job_type'],
    \`projectType\` String MATERIALIZED properties['projectType'],
    \`payments-experiment-master\` String MATERIALIZED properties['payments-experiment-master'],
    \`searchResultType\` String MATERIALIZED properties['searchResultType'],
    \`gateway\` String MATERIALIZED properties['gateway'],
    \`userCount\` String MATERIALIZED properties['userCount'],
    \`product\` String MATERIALIZED properties['product'],
    \`productPrice\` String MATERIALIZED properties['productPrice'],
    \`step\` String MATERIALIZED properties['step'],
    \`variant\` String MATERIALIZED properties['variant'],
    \`job\` String MATERIALIZED properties['job'],
    \`$ae_crashed_reason\` String MATERIALIZED properties['$ae_crashed_reason'],
    \`isTruecallerAvailable\` String MATERIALIZED properties['isTruecallerAvailable'],
    \`deemphasize-play-store\` String MATERIALIZED properties['deemphasize-play-store'],
    \`npci-preselection-exp\` String MATERIALIZED properties['npci-preselection-exp'],
    \`orgId\` String MATERIALIZED properties['orgId'],
    \`p50FrameMs\` String MATERIALIZED properties['p50FrameMs'],
    \`inference_model\` String MATERIALIZED properties['inference_model'],
    \`phase\` String MATERIALIZED properties['phase'],
    \`aspectRatio\` String MATERIALIZED properties['aspectRatio'],
    \`tabKey\` String MATERIALIZED properties['tabKey'],
    \`org_id\` String MATERIALIZED properties['org_id'],
    \`metadata_type\` LowCardinality(String) MATERIALIZED ifNull(properties['metadata_type'], ''),
    \`thumbnail_container_index\` String MATERIALIZED properties['thumbnail_container_index'],
    \`PREFERRED_LANGUAGE\` String MATERIALIZED properties['PREFERRED_LANGUAGE'],
    \`lang\` String MATERIALIZED properties['lang'],
    \`kind\` String MATERIALIZED properties['kind'],
    \`shortfree-recsys-model-version\` String MATERIALIZED properties['shortfree-recsys-model-version'],
    \`isError\` String MATERIALIZED properties['isError'],
    \`__buildNumber\` String MATERIALIZED properties['__buildNumber'],
    \`prop_country\` String MATERIALIZED properties['country'],
    \`prop_name\` String MATERIALIZED properties['name'],
    \`isRenewal\` String MATERIALIZED properties['isRenewal'],
    \`$referrer\` String MATERIALIZED properties['$referrer'],
    \`planName\` String MATERIALIZED properties['planName'],
    \`cancellationReason\` String MATERIALIZED properties['cancellationReason'],
    \`appVersion\` String MATERIALIZED properties['appVersion'],
    \`ref_utm_source\` String MATERIALIZED properties['ref_utm_source'],
    \`utm_source\` String MATERIALIZED properties['utm_source'],
    \`success\` String MATERIALIZED properties['success'],
    \`failureReason\` String MATERIALIZED properties['failureReason'],
    \`page\` String MATERIALIZED properties['page'],
    \`quotaPlan\` String MATERIALIZED properties['quotaPlan'],
    -- skip indexes (exact mirror of events; idx_name is now redundant with name in the
    -- primary key but kept to minimise divergence — can be dropped in a later cleanup)
    INDEX idx_name name TYPE bloom_filter GRANULARITY 1,
    INDEX idx_properties_bounce properties['__bounce'] TYPE set(3) GRANULARITY 1,
    INDEX idx_origin origin TYPE bloom_filter(0.05) GRANULARITY 1,
    INDEX idx_path path TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_prop_search_type searchType TYPE set(10) GRANULARITY 4,
    INDEX idx_prop_source source TYPE set(100) GRANULARITY 4,
    INDEX idx_prop_is_explore isExplore TYPE set(5) GRANULARITY 4,
    INDEX idx_prop_source_show sourceShowName TYPE bloom_filter(0.001) GRANULARITY 4,
    INDEX idx_prop_show_name showName TYPE bloom_filter(0.001) GRANULARITY 4,
    INDEX idx_af_adset_id af_adset_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_profile_id profile_id TYPE bloom_filter GRANULARITY 1,
    INDEX idx_session_id session_id TYPE bloom_filter GRANULARITY 1,
    INDEX idx_country country TYPE set(0) GRANULARITY 1
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (project_id, toDate(created_at), name, cityHash64(profile_id), created_at)
SAMPLE BY cityHash64(profile_id)
TTL toDate(created_at) + toIntervalMonth(4)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1`,
];

export async function up() {
  console.log('='.repeat(60));
  console.log('  23 — CREATE events_v2 (Stage 1: empty scaffold only)');
  console.log('='.repeat(60));
  console.log(
    '\nCreating events_v2 with the name-first sort key + SAMPLE BY cityHash64(profile_id).',
  );
  console.log('No dual-write MV, no backfill — those are separate, gated steps.');

  await runClickhouseMigrationCommands(DDL);

  console.log('\n  events_v2 created (or already existed).');
  console.log('\n' + '='.repeat(60));
  console.log('  23 COMPLETE');
  console.log('  Next (separate + gated):');
  console.log('   1. Backfill ONE day → benchmark the key (Inv 7) vs events.');
  console.log('   2. Only if it holds: dual-write MV + day-by-day backfill.');
  console.log('   3. EXCHANGE TABLES cutover.');
  console.log('='.repeat(60));
}

export async function down() {
  // No automatic teardown. events_v2 holds backfilled + live dual-write data;
  // dropping it here would be a data-loss footgun (and break ingestion while the
  // MV is live). Drop events_to_v2 + events_v2 MANUALLY if we ever truly unwind.
  console.log(
    'No down migration — drop events_to_v2 + events_v2 manually if needed.',
  );
}
