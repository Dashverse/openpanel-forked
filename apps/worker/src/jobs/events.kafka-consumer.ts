import {
  createKafkaEventsConsumer,
  type EventsQueuePayloadIncomingEvent,
  KAFKA_EVENTS_TOPIC,
  KAFKA_PARTITIONS_CONCURRENT,
  kafkaLogger,
  type KafkaMessage,
} from '@openpanel/queue';
import {
  kafkaConsumeErrorsTotal,
  kafkaConsumerLag,
  kafkaEventsConsumedTotal,
  kafkaPartitionOwner,
  kafkaReprocessedTotal,
} from '../metrics';
import { logger } from '../utils/logger';
import { incomingEvent } from './events.incoming-event';

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
      // can't race; different keys run in parallel via Promise.all.
      // Keyless messages get their own singleton group.
      const groups = new Map<string, KafkaMessage[]>();
      for (const m of batch.messages) {
        const key = m.key ? m.key.toString() : `__no_key__:${m.offset}`;
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
                try {
                  await incomingEvent(payload);
                  kafkaEventsConsumedTotal.inc({
                    partition: String(batch.partition),
                  });
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
