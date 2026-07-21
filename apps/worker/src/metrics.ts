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

for (const buffer of [
  eventBuffer,
  profileBuffer,
  sessionBuffer,
  replayBuffer,
  botBuffer,
]) {
  buffer.flushObserver = (obs: FlushObservation) => {
    const labels = { buffer: obs.buffer, result: obs.result };
    bufferFlushDuration.observe({ ...labels, phase: 'total' }, obs.totalMs);
    if (obs.phases) {
      for (const [key, value] of Object.entries(obs.phases)) {
        if (typeof value === 'number') {
          bufferFlushDuration.observe({ ...labels, phase: key }, value);
        }
      }
    }
  };
}

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
