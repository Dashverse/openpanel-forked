CREATE TABLE IF NOT EXISTS session_replay_blocks (
  `project_id` String CODEC(ZSTD(3)),
  `session_id` String CODEC(ZSTD(3)),
  `window_id` String DEFAULT '' CODEC(ZSTD(3)),
  `block_index` UInt64,
  `blob_path` String CODEC(ZSTD(3)),
  `byte_start` UInt64,
  `byte_end` UInt64,
  `chunk_lo` UInt16,
  `chunk_hi` UInt16,
  `first_started_at` DateTime64(3) CODEC(DoubleDelta, ZSTD(3)),
  `last_started_at` DateTime64(3) CODEC(DoubleDelta, ZSTD(3)),
  `events_count` UInt32,
  `size_bytes` UInt64,
  `codec` LowCardinality(String) DEFAULT 'zstd',
  `created_at` DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(created_at)
PARTITION BY toYYYYMMDD(first_started_at)
ORDER BY (project_id, session_id, block_index)
SETTINGS index_granularity = 8192;