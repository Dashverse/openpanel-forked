import client from 'prom-client';

import {
  botBuffer,
  eventBuffer,
  type FlushObservation,
  profileBuffer,
  replayBuffer,
  sessionBuffer,
} from '@openpanel/db';
import { cronQueue, eventsGroupQueues, sessionsQueue } from '@openpanel/queue';
import { getRedisCache } from '@openpanel/redis';

const bufferRedis = getRedisCache();

async function readRedisMemoryField(field: 'used_memory' | 'maxmemory') {
  const info = await bufferRedis.info('memory');
  return Number(info.match(new RegExp(`^${field}:(\\d+)`, 'm'))?.[1] ?? 0);
}

const Registry = client.Registry;

export const register = new Registry();

const queues = [sessionsQueue, cronQueue, ...eventsGroupQueues];

// Histogram to track job processing time for eventsGroupQueues
export const eventsGroupJobDuration = new client.Histogram({
  name: 'job_duration_ms',
  help: 'Duration of job processing (in ms)',
  labelNames: ['name', 'status'],
  buckets: [10, 25, 50, 100, 250, 500, 750, 1000, 2000, 5000, 10000, 30000], // 10ms to 30s
});

register.registerMetric(eventsGroupJobDuration);

// Per-buffer flush duration histogram — bridges each buffer's flushObserver
// hook into Prometheus. Labels let a dashboard split by buffer + result +
// phase, so during an incident we can see e.g. "replay chInsertMs p95
// spiked" or "replay flushes failing" instantly instead of grepping logs.
// The buffer_flush_duration_ms_count series (auto-emitted by histograms)
// doubles as the failure counter — filter by result='error' or 'locked'.
const bufferFlushDuration = new client.Histogram({
  name: 'buffer_flush_duration_ms',
  help: 'Duration of a buffer flush cycle in ms, per buffer / phase / result',
  labelNames: ['buffer', 'phase', 'result'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
});
register.registerMetric(bufferFlushDuration);

// Total rows the flush actually pushed to CH per buffer/result. Lets a
// dashboard show "events landed in CH per second" — the SLA-relevant
// throughput number — via rate() on this counter. The histogram alone
// only counts flush cycles, not rows per cycle.
const bufferRowsInserted = new client.Counter({
  name: 'buffer_rows_inserted_total',
  help: 'Total rows inserted into CH from a buffer flush cycle',
  labelNames: ['buffer', 'result'],
});
register.registerMetric(bufferRowsInserted);

const handleFlushObservation = (obs: FlushObservation) => {
  const labels = { buffer: obs.buffer, result: obs.result };
  bufferFlushDuration.observe({ ...labels, phase: 'total' }, obs.totalMs);
  if (obs.phases) {
    for (const [key, value] of Object.entries(obs.phases)) {
      if (typeof value === 'number') {
        bufferFlushDuration.observe({ ...labels, phase: key }, value);
      }
    }
  }
  if (obs.rowsProcessed) {
    bufferRowsInserted.inc(labels, obs.rowsProcessed);
  }
};

for (const buffer of [
  eventBuffer,
  profileBuffer,
  sessionBuffer,
  replayBuffer,
  botBuffer,
]) {
  buffer.flushObserver = handleFlushObservation;
}

// Counts Kafka messages redelivered (at-least-once duplicates) outside of a
// rebalance — the signature of an offset-handling bug. Should stay flat at 0.
export const kafkaReprocessedTotal = new client.Counter({
  name: 'kafka_reprocessed_total',
  help: 'Kafka messages redelivered outside a rebalance (at-least-once duplicates)',
  labelNames: ['partition'],
});

register.registerMetric(kafkaReprocessedTotal);

// Events successfully handed to incomingEvent() from the Kafka consumer.
// Compare against Event Hubs "IncomingMessages" (portal) to see produce→consume
// throughput and spot the consumer falling behind during the migration.
export const kafkaEventsConsumedTotal = new client.Counter({
  name: 'kafka_events_consumed_total',
  help: 'Kafka event messages processed by the consumer',
  labelNames: ['partition'],
});

// incomingEvent() threw for a Kafka message (logged + acked, at-most-once).
export const kafkaConsumeErrorsTotal = new client.Counter({
  name: 'kafka_consume_errors_total',
  help: 'Kafka events whose incomingEvent handler threw',
  labelNames: ['partition'],
});

register.registerMetric(kafkaEventsConsumedTotal);
register.registerMetric(kafkaConsumeErrorsTotal);

// Consumer lag per partition = broker high-watermark − last committed offset.
// Azure Event Hubs exposes NO native consumer-lag metric, so we compute it in
// the consumer from batch.highWatermark. This is the #1 health signal — the
// Kafka equivalent of GroupMQ's group_events_N_waiting_count. Rising = the
// consumer is falling behind → scale worker pods.
export const kafkaConsumerLag = new client.Gauge({
  name: 'kafka_consumer_lag',
  help: 'Kafka consumer lag (messages behind the partition high-watermark)',
  labelNames: ['partition'],
});

register.registerMetric(kafkaConsumerLag);

// Absolute Kafka offsets per partition, for full offset visibility on the
// per-partition dashboard: `committed` = the last offset we've acked, `high
// watermark` = the broker's next-write position (log end). The relationship is
// kafka_consumer_lag = kafka_high_watermark - 1 - kafka_committed_offset, so the
// three together read like a Kafka console: "partition N acked at X, log ends at
// Y, Z behind." Set from the consumer's own state (resolvedHWM + batch
// .highWatermark) — no broker admin API needed.
export const kafkaCommittedOffset = new client.Gauge({
  name: 'kafka_committed_offset',
  help: 'Last Kafka offset committed (acked) by the consumer, per partition',
  labelNames: ['partition'],
});

export const kafkaHighWatermark = new client.Gauge({
  name: 'kafka_high_watermark',
  help: 'Kafka partition high-watermark (next offset to be written), per partition',
  labelNames: ['partition'],
});

register.registerMetric(kafkaCommittedOffset);
register.registerMetric(kafkaHighWatermark);

// Which pod currently owns each Kafka partition in the consumer group. Value is
// always 1; there is one series per (partition, pod) the pod owns, set on
// GROUP_JOIN and removed when a rebalance moves the partition elsewhere. Lets a
// per-partition dashboard show the owning pod — the Kafka equivalent of seeing
// which worker holds a GroupMQ shard. `pod` = the worker's hostname (K8s pod
// name). Exactly one pod should report 1 per partition; two = a rebalance not
// yet settled (or a stale series if clearing regressed).
export const kafkaPartitionOwner = new client.Gauge({
  name: 'kafka_partition_owner',
  help: 'Pod that currently owns a Kafka partition in the consumer group (value always 1)',
  labelNames: ['partition', 'pod'],
});

register.registerMetric(kafkaPartitionOwner);

queues.forEach((queue) => {
  register.registerMetric(
    new client.Gauge({
      name: `${queue.name.replace(/[\{\}]/g, '')}_active_count`,
      help: 'Active count',
      async collect() {
        const metric = await queue.getActiveCount();
        this.set(metric);
      },
    }),
  );

  register.registerMetric(
    new client.Gauge({
      name: `${queue.name.replace(/[\{\}]/g, '')}_delayed_count`,
      help: 'Delayed count',
      async collect() {
        const metric = await queue.getDelayedCount();
        this.set(metric);
      },
    }),
  );

  register.registerMetric(
    new client.Gauge({
      name: `${queue.name.replace(/[\{\}]/g, '')}_failed_count`,
      help: 'Failed count',
      async collect() {
        const metric = await queue.getFailedCount();
        this.set(metric);
      },
    }),
  );

  register.registerMetric(
    new client.Gauge({
      name: `${queue.name.replace(/[\{\}]/g, '')}_completed_count`,
      help: 'Completed count',
      async collect() {
        const metric = await queue.getCompletedCount();
        this.set(metric);
      },
    }),
  );

  register.registerMetric(
    new client.Gauge({
      name: `${queue.name.replace(/[\{\}]/g, '')}_waiting_count`,
      help: 'Waiting count',
      async collect() {
        const metric = await queue.getWaitingCount();
        this.set(metric);
      },
    }),
  );
});

register.registerMetric(
  new client.Gauge({
    name: `buffer_${eventBuffer.name}_count`,
    help: 'Number of unprocessed events',
    async collect() {
      const metric = await eventBuffer.getBufferSize();
      this.set(metric);
    },
  }),
);

register.registerMetric(
  new client.Gauge({
    name: `buffer_${profileBuffer.name}_count`,
    help: 'Number of unprocessed profiles',
    async collect() {
      const metric = await profileBuffer.getBufferSize();
      this.set(metric);
    },
  }),
);

register.registerMetric(
  new client.Gauge({
    name: `buffer_${botBuffer.name}_count`,
    help: 'Number of unprocessed bot events',
    async collect() {
      const metric = await botBuffer.getBufferSize();
      this.set(metric);
    },
  }),
);

register.registerMetric(
  new client.Gauge({
    name: `buffer_${sessionBuffer.name}_count`,
    help: 'Number of unprocessed sessions',
    async collect() {
      const metric = await sessionBuffer.getBufferSize();
      this.set(metric);
    },
  }),
);

register.registerMetric(
  new client.Gauge({
    name: `buffer_${replayBuffer.name}_count`,
    help: 'Number of unprocessed replay chunks',
    async collect() {
      const metric = await replayBuffer.getBufferSize();
      this.set(metric);
    },
  }),
);

// Per-buffer memory bytes (Redis MEMORY USAGE on the underlying key).
// One gauge per buffer type so a dashboard can attribute Redis growth.
// Errors are swallowed so a Redis blip on one buffer doesn't fail the whole
// scrape and take out every other metric (prom-client fails the registry if
// any collect() throws).
for (const buffer of [
  eventBuffer,
  profileBuffer,
  sessionBuffer,
  replayBuffer,
  botBuffer,
]) {
  register.registerMetric(
    new client.Gauge({
      name: `buffer_${buffer.name}_bytes`,
      help: `Redis memory usage (bytes) held by the ${buffer.name} buffer`,
      async collect() {
        try {
          this.set(await buffer.getBufferBytes());
        } catch {
          // Skip this scrape; keep the last observed value.
        }
      },
    }),
  );
}

// Buffer Redis memory footprint (getRedisCache — where all buffers live).
// Scoped to the cache/queue Redis only; session store Redis (REDIS_SESSION_URL)
// is a different instance and not measured here.
register.registerMetric(
  new client.Gauge({
    name: 'buffer_redis_used_memory_bytes',
    help: 'used_memory of the buffer/cache Redis (from INFO memory)',
    async collect() {
      try {
        this.set(await readRedisMemoryField('used_memory'));
      } catch {
        // Skip this scrape; keep the last observed value.
      }
    },
  }),
);

register.registerMetric(
  new client.Gauge({
    name: 'buffer_redis_maxmemory_bytes',
    help: 'maxmemory of the buffer/cache Redis (0 = unlimited)',
    async collect() {
      try {
        this.set(await readRedisMemoryField('maxmemory'));
      } catch {
        // Skip this scrape; keep the last observed value.
      }
    },
  }),
);
