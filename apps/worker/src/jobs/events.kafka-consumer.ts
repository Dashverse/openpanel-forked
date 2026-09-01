import {
  createKafkaEventsConsumer,
  type EventsQueuePayloadIncomingEvent,
  KAFKA_EVENTS_TOPIC,
  KAFKA_PARTITIONS_CONCURRENT,
  kafkaLogger,
  type KafkaMessage,
} from '@openpanel/queue';
import { getRedisCache } from '@openpanel/redis';
import {
  kafkaCommittedOffset,
  kafkaConsumeErrorsTotal,
  kafkaConsumerLag,
  kafkaDedupSkippedTotal,
  kafkaEventsConsumedTotal,
  kafkaHighWatermark,
  kafkaPartitionOwner,
  kafkaReprocessedTotal,
} from '../metrics';
import { logger } from '../utils/logger';
import { incomingEvent } from './events.incoming-event';

// How long we remember a processed event's dedup key. A producer/SDK retry
// lands within seconds, so this only needs to outlast the retry window. 6h
// gives generous headroom for the common case while keeping Redis memory
// bounded — at ~3k/s that's ~65M keys (~6GB), vs ~24× that for a 24h window,
// which would risk evicting the event/session buffers on the shared Redis.
// Keys auto-expire. Tunable via KAFKA_DEDUP_TTL_SECONDS.
const DEDUP_TTL_SECONDS = Number.parseInt(
  process.env.KAFKA_DEDUP_TTL_SECONDS || '21600',
  10,
);

export interface KafkaConsumerHandle {
  stop: () => Promise<void>;
}

// Heartbeat every N messages within a per-key group. The default kafkajs
// sessionTimeout is 30s — calling heartbeat every 16 messages keeps us
// comfortably under that even for slow handlers.
const HEARTBEAT_EVERY = 16;

// Highest Kafka offset we have *resolved* (committed) per `topic-partition`,
// tracked across batches. Used purely for the reprocess detector below: if we
// ever see an offset at or below this watermark again, the message is being
// redelivered (at-least-once duplicate) outside of a rebalance — which is the
// signature of an offset-handling bug. Cleared on GROUP_JOIN so legitimate
// post-rebalance redelivery from the last committed offset doesn't trip it.
const resolvedHWM = new Map<string, number>();

// This worker's pod identity for the kafka_partition_owner gauge. In K8s the
// container hostname is the pod name; fall back to something non-empty locally.
const POD = process.env.HOSTNAME || process.env.POD_NAME || 'unknown';

// Routing key that keeps a device's/profile's events serial so the non-atomic
// session-buffer read-modify-write can't race. When produced via the Kafka
// protocol this is the record key (m.key). The Azure Event Hubs producer routes
// by an AMQP partitionKey that is NOT exposed as the Kafka key, so m.key is
// empty there — fall back to __groupId carried in the payload (the exact value
// the producer partitioned by; set in packages/queue/src/eventhub-producer.ts),
// then currentDeviceId, then a per-offset singleton as a last resort. Same-key
// events share one ordered partition, so grouping by it restores serial-per-key.
// (Incident 2026-08-14: empty m.key made every message its own singleton group
// → a device's events processed in parallel → duplicate/uncollapsible session
// rows.)
const messageGroupKey = (m: KafkaMessage): string => {
  if (m.key) {
    return m.key.toString();
  }
  if (m.value) {
    try {
      const p = JSON.parse(m.value.toString()) as {
        __groupId?: string;
        currentDeviceId?: string;
      };
      const k = p.__groupId || p.currentDeviceId;
      if (k) {
        return k;
      }
    } catch {
      // malformed value → fall through to a singleton group
    }
  }
  return `__no_key__:${m.offset}`;
};

// Partitions this pod currently owns, so on the next GROUP_JOIN we can clear the
// owner gauge for any partition that moved to another member (otherwise a stale
// `owner=1` would linger and make two pods look like they own the same one).
let ownedPartitions = new Set<number>();

export async function startKafkaEventsConsumer(): Promise<KafkaConsumerHandle> {
  const consumer = createKafkaEventsConsumer();
  await consumer.connect();
  await consumer.subscribe({
    topic: KAFKA_EVENTS_TOPIC,
    fromBeginning: false,
  });

  // ---- Lifecycle / rebalance ("re-election") visibility ----
  // Without this a rebalance storm (a common source of at-least-once
  // duplicates) is invisible.
  consumer.on(consumer.events.GROUP_JOIN, ({ payload }) => {
    // A new assignment means partitions may have moved between members; reset
    // the reprocess watermarks so legitimate resume-from-committed-offset after
    // a rebalance is not flagged as a duplicate.
    resolvedHWM.clear();

    // Seed the error + reprocess counters at 0 for every partition assigned to
    // this member. prom-client emits NO time series for a labelled counter
    // until it is incremented at least once, so on a healthy consumer these two
    // metrics never appear in /metrics — SigNoz can't graph or alert on a
    // metric it has never received. Partitions are known here at join time, so
    // `.inc(…, 0)` (a no-op on the value) materialises the series immediately:
    // panels render every partition at 0 and alerts sit in "OK" rather than
    // "No Data" until a real error/duplicate bumps them. Stale 0-series for a
    // partition later reassigned elsewhere are harmless — summed across pods the
    // owning pod's real value still wins.
    const assignment = (payload.memberAssignment?.[KAFKA_EVENTS_TOPIC] ?? []) as
      | number[]
      | Record<string, number>;
    const partitions = Array.isArray(assignment)
      ? assignment
      : Object.values(assignment);
    for (const partition of partitions) {
      const p = String(partition);
      kafkaConsumeErrorsTotal.inc({ partition: p }, 0);
      kafkaReprocessedTotal.inc({ partition: p }, 0);
    }

    // Update the partition-owner gauge so a per-partition dashboard can show
    // which pod holds each partition (the Kafka equivalent of seeing which
    // worker owns a GroupMQ shard). Claim every partition now assigned to this
    // pod, and release any we owned before this rebalance but no longer do —
    // otherwise a moved partition would keep showing this pod as its owner and
    // two pods would appear to own the same partition.
    const assignedNow = new Set(partitions.map(Number));
    for (const prev of ownedPartitions) {
      if (!assignedNow.has(prev)) {
        kafkaPartitionOwner.remove(String(prev), POD);
      }
    }
    for (const partition of assignedNow) {
      kafkaPartitionOwner.set({ partition: String(partition), pod: POD }, 1);
    }
    ownedPartitions = assignedNow;

    logger.info('kafka consumer joined group (rebalance complete)', {
      memberId: payload.memberId,
      groupId: payload.groupId,
      isLeader: payload.isLeader,
      memberAssignment: payload.memberAssignment,
      partitionsSeeded: partitions.length,
      duration: payload.duration,
    });
  });
  consumer.on(consumer.events.REBALANCING, ({ payload }) => {
    logger.warn('kafka consumer rebalancing', {
      memberId: payload.memberId,
      groupId: payload.groupId,
    });
  });
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    logger.error('kafka consumer crashed', {
      error: payload.error,
      groupId: payload.groupId,
      restart: payload.restart,
    });
  });
  consumer.on(consumer.events.DISCONNECT, () => {
    // Release this pod's owner gauges on disconnect so a leaving/terminating pod
    // stops reporting itself as a partition owner; the surviving members
    // re-claim on their next GROUP_JOIN.
    for (const prev of ownedPartitions) {
      kafkaPartitionOwner.remove(String(prev), POD);
    }
    ownedPartitions = new Set();
    logger.warn('kafka consumer disconnected');
  });
  consumer.on(consumer.events.REQUEST_TIMEOUT, ({ payload }) => {
    logger.warn('kafka consumer request timeout', {
      broker: payload.broker,
      clientId: payload.clientId,
    });
  });

  await consumer.run({
    partitionsConsumedConcurrently: KAFKA_PARTITIONS_CONCURRENT,
    eachBatchAutoResolve: false,
    eachBatch: async ({
      batch,
      resolveOffset,
      heartbeat,
      isRunning,
      isStale,
    }) => {
      if (batch.messages.length === 0) {
        return;
      }

      const pk = `${batch.topic}-${batch.partition}`;
      // Watermark from *previous* batches. Anything at or below this that we see
      // now is a redelivery. Captured before this batch so intra-batch
      // out-of-order processing (normal, see below) is never counted.
      const priorHWM = resolvedHWM.get(pk) ?? -1;

      // Group by partition key (= deviceId or `${projectId}:${profileId}`).
      // Same-key messages stay serial so sessionBuffer/session-end-job state
      // can't race; different keys run in parallel via Promise.all. The key
      // comes from m.key (Kafka protocol) or the payload's __groupId/deviceId
      // (Azure Event Hubs, whose partitionKey isn't exposed as m.key) — see
      // messageGroupKey. Only a truly unidentifiable message becomes a singleton.
      const groups = new Map<string, KafkaMessage[]>();
      for (const m of batch.messages) {
        const key = messageGroupKey(m);
        const arr = groups.get(key);
        if (arr) {
          arr.push(m);
        } else {
          groups.set(key, [m]);
        }
      }

      // Offsets that finished processing this batch. We resolve them AFTER all
      // groups complete, in strict ascending order (see the loop below).
      //
      // Why: KafkaJS `resolveOffset` is last-write-wins and the next fetch
      // starts from the last resolved offset (offsetManager.nextOffset). If we
      // resolved inside the concurrent per-key loop, a lower offset resolving
      // after a higher one would move the fetch position BACKWARDS and
      // re-deliver everything in between — the root cause of the duplicate
      // events. Resolving the contiguous ascending prefix at the end avoids
      // both duplicates (never regress) and loss (stop at the first gap).
      const processed = new Set<string>();
      let processedCount = 0;

      await Promise.all(
        [...groups.values()].map(async (msgs) => {
          for (const m of msgs) {
            if (!isRunning() || isStale()) {
              return;
            }

            // Reprocess detector: only fires for offsets already resolved in a
            // PRIOR batch (redelivery). Intra-batch out-of-order processing
            // across key-groups is expected and is not flagged.
            if (Number(m.offset) <= priorHWM) {
              kafkaReprocessedTotal.inc({ partition: String(batch.partition) });
              logger.warn(
                'kafka offset REPROCESSED — at-least-once duplicate (outside rebalance)',
                {
                  partition: batch.partition,
                  offset: m.offset,
                  resolvedHighWaterMark: priorHWM,
                },
              );
            }

            if (m.value) {
              let payload: EventsQueuePayloadIncomingEvent['payload'] | null =
                null;
              try {
                payload = JSON.parse(
                  m.value.toString(),
                ) as EventsQueuePayloadIncomingEvent['payload'];
              } catch (err) {
                logger.error('kafka message parse failed', {
                  error: err,
                  partition: batch.partition,
                  offset: m.offset,
                });
              }
              if (payload) {
                // Idempotency: a producer retry (after an Event Hubs ack
                // timeout) or an SDK retry (after a 5xx) re-sends the same event.
                // Dedup key = the client `$insert_id` when present, else the
                // server jobId carried as `__jobId`. Namespaced by projectId so a
                // key can never collide across projects.
                const insertId = (
                  payload.event?.properties as
                    | Record<string, unknown>
                    | undefined
                )?.['$insert_id'];
                const dedupId =
                  (typeof insertId === 'string' && insertId
                    ? insertId
                    : undefined) ?? (payload as { __jobId?: string }).__jobId;
                const dedupKey = dedupId
                  ? `op:dedup:${payload.projectId}:${dedupId}`
                  : undefined;

                // CHECK only (not reserve): skip an event we've ALREADY
                // processed. We record the key AFTER a successful incomingEvent
                // (below), never before — so a crash between here and a
                // successful write causes a re-process (a duplicate the dedup
                // then catches) instead of silently DROPPING the event. Same-key
                // retries land on the same partition and are serialized in this
                // per-group loop, so there is no check→mark race for them.
                let duplicate = false;
                if (dedupKey) {
                  try {
                    duplicate = (await getRedisCache().exists(dedupKey)) === 1;
                  } catch (err) {
                    // Fail OPEN on a dedup-store blip: process the event. At
                    // worst a retry duplicates; we never DROP an event because
                    // Redis hiccuped.
                    logger.warn('kafka dedup check failed; processing anyway', {
                      error: err,
                      partition: batch.partition,
                      offset: m.offset,
                    });
                  }
                }
                if (duplicate) {
                  kafkaDedupSkippedTotal.inc({
                    partition: String(batch.partition),
                  });
                } else {
                  try {
                    await incomingEvent(payload);
                    kafkaEventsConsumedTotal.inc({
                      partition: String(batch.partition),
                    });
                    // Mark processed ONLY after success. Best-effort: a failed
                    // mark risks a future duplicate, never a loss. Not marked on
                    // a handler throw either, so a retry can re-attempt.
                    if (dedupKey) {
                      try {
                        await getRedisCache().set(
                          dedupKey,
                          '1',
                          'EX',
                          DEDUP_TTL_SECONDS,
                        );
                      } catch (err) {
                        logger.warn('kafka dedup mark failed', {
                          error: err,
                          partition: batch.partition,
                          offset: m.offset,
                        });
                      }
                    }
                  } catch (err) {
                    // Match the GroupMQ behaviour: log and ack. At-most-once on
                    // handler exceptions; failures here would otherwise block the
                    // partition.
                    kafkaConsumeErrorsTotal.inc({
                      partition: String(batch.partition),
                    });
                    logger.error('kafka incomingEvent handler failed', {
                      error: err,
                      partition: batch.partition,
                      offset: m.offset,
                      projectId: payload.projectId,
                    });
                  }
                }
              }
            }

            processed.add(m.offset);
            processedCount += 1;
            if (processedCount % HEARTBEAT_EVERY === 0) {
              await heartbeat();
            }
          }
        }),
      );

      // Resolve in strict ascending offset order, stopping at the first offset
      // that did not finish (e.g. an isStale/isRunning early-return mid-batch).
      // batch.messages is already ordered by offset.
      let newHWM = priorHWM;
      for (const m of batch.messages) {
        if (!processed.has(m.offset)) {
          break;
        }
        resolveOffset(m.offset);
        newHWM = Math.max(newHWM, Number(m.offset));
      }
      resolvedHWM.set(pk, newHWM);

      // Consumer lag = broker high-watermark − last committed offset. batch
      // .highWatermark is the next offset to be written (last message + 1), so
      // when fully caught up: highWatermark − 1 − newHWM = 0. Positive = more
      // messages arrived than we've committed → we're behind on this partition.
      kafkaConsumerLag.set(
        { partition: String(batch.partition) },
        Math.max(0, Number(batch.highWatermark) - 1 - newHWM),
      );

      // Absolute offsets for full per-partition visibility (committed = acked
      // position, high-watermark = log end). Same source values as the lag
      // above, just exposed directly so the dashboard can show where each
      // partition is acked and where the log ends, not only the gap.
      kafkaCommittedOffset.set({ partition: String(batch.partition) }, newHWM);
      kafkaHighWatermark.set(
        { partition: String(batch.partition) },
        Number(batch.highWatermark),
      );

      await heartbeat();
    },
  });

  kafkaLogger.info('kafka events consumer running', {
    topic: KAFKA_EVENTS_TOPIC,
    partitionsConsumedConcurrently: KAFKA_PARTITIONS_CONCURRENT,
  });

  return {
    stop: async () => {
      await consumer.disconnect();
    },
  };
}
