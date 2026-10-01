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
