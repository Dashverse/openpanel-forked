import client from 'prom-client';

// Producer-side metrics for the session-replay Kafka path. The producer runs in
// the API process, so these live here (the consumer's metrics live in the
// worker). Registered on prom-client's default registry, which `fastify-metrics`
// serves at /metrics.

export const replayKafkaProducedTotal = new client.Counter({
  name: 'replay_kafka_produced_total',
  help: 'Session-replay chunks produced to the replay Kafka topic',
});

export const replayKafkaDroppedTotal = new client.Counter({
  name: 'replay_kafka_dropped_total',
  help: 'Session-replay chunks NOT produced to Kafka, by reason',
  labelNames: ['reason'] as const,
});

// Materialize the label series at 0 so dashboards/alerts render before the first
// real drop (prom-client emits no series for a labelled counter until inc()).
replayKafkaDroppedTotal.inc({ reason: 'oversize' }, 0);
replayKafkaDroppedTotal.inc({ reason: 'produce_failed' }, 0);
// `backpressure` = admission-cap rejection; the SDK retries, so it is NOT a
// confirmed drop — kept separate from produce_failed so the loss signal is clean.
replayKafkaDroppedTotal.inc({ reason: 'backpressure' }, 0);

// Chunks whose compressed value is over the per-message limit (REPLAY_KAFKA_MAX_BYTES)
// are sent as several transport parts (one message each) and joined back by
// the worker. chunks_split counts those chunks, parts_produced their messages.
export const replayKafkaChunksSplitTotal = new client.Counter({
  name: 'replay_kafka_chunks_split_total',
  help: 'Session-replay chunks produced as several transport parts (compressed value over the per-message limit)',
});

export const replayKafkaPartsProducedTotal = new client.Counter({
  name: 'replay_kafka_parts_produced_total',
  help: 'Transport-part messages of split session-replay chunks produced to Kafka',
});

// Compressed size of chunks dropped as oversize (over REPLAY_KAFKA_MAX_TOTAL_BYTES),
// split by whether the chunk carries a full snapshot, to size the total cap.
export const replayKafkaOversizeBytes = new client.Histogram({
  name: 'replay_kafka_oversize_bytes',
  help: 'Compressed (REPLAY_KAFKA_CODEC) size of session-replay chunks dropped as oversize',
  labelNames: ['is_full_snapshot'] as const,
  buckets: [
    1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000, 50_000_000,
    100_000_000,
  ],
});
