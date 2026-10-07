import { insertReplayChunks } from '@openpanel/db';
import {
  KAFKA_REPLAY_TOPIC,
  createKafkaReplayConsumer,
  decompressReplayLine,
  kafkaLogger,
} from '@openpanel/queue';
import {
  context,
  contextFromTraceparent,
  withQueryContext,
  withSpan,
} from '@openpanel/telemetry';
import {
  replayKafkaConsumeErrorsTotal,
  replayKafkaConsumedTotal,
  replayKafkaConsumerLag,
} from '../metrics';
import { logger } from '../utils/logger';

export interface ReplayKafkaConsumerHandle {
  stop: () => Promise<void>;
}

// Replay is MUCH simpler than the events consumer: a chunk is a self-contained
// row appended to session_replay_chunks — there is no session read-modify-write
// to serialize, so we don't group by key, and no ReplacingMergeTree collapse to
// protect, so there's no dedup (Phase 1: measure duplicates, add later if any).
// A batch is: decompress every value → collect the JSONEachRow lines → one bulk
// insertReplayChunks → resolve the whole contiguous prefix. On a decompress or
// insert error we DON'T resolve, so kafkajs redelivers the batch (at-least-once)
// rather than dropping replay — a redelivery at worst duplicates a chunk (Phase
// 1 accepted), it never loses one.

const POD = process.env.HOSTNAME || process.env.POD_NAME || 'unknown';

// A fat-payload insert can outlast the 30s consumer sessionTimeout (the CH
// client's own request timeout is 1h), which would get this member kicked and
// the batch reprocessed on another pod. So while an insert is in flight we
// heartbeat every HEARTBEAT_EVERY_MS, and abort the insert after INSERT_TIMEOUT_MS
// (below sessionTimeout) — a timed-out insert takes the normal failure path.
const HEARTBEAT_EVERY_MS = 3_000;
const INSERT_TIMEOUT_MS = Number.parseInt(
  process.env.REPLAY_KAFKA_INSERT_TIMEOUT_MS || '25000',
  10,
);

export async function startKafkaReplayConsumer(): Promise<ReplayKafkaConsumerHandle> {
  const consumer = createKafkaReplayConsumer();
  await consumer.connect();
  // fromBeginning only applies when the group has no committed offset yet (first
  // start); afterwards it resumes from the committed offset. On the dedicated,
  // short-retention replay topic this makes rollout order-independent: chunks
  // produced before the consumer first joins are still consumed, not skipped.
  await consumer.subscribe({ topic: KAFKA_REPLAY_TOPIC, fromBeginning: true });

  // Partitions this pod currently owns, so a rebalance can clear stale lag
  // gauges for partitions that moved to another member (a left-behind lag
  // series would be summed across pods and multiply the reported lag).
  let ownedPartitions = new Set<number>();

  consumer.on(consumer.events.GROUP_JOIN, ({ payload }) => {
    const assignment = (payload.memberAssignment?.[KAFKA_REPLAY_TOPIC] ?? []) as
      | number[]
      | Record<string, number>;
    const partitions = Array.isArray(assignment)
      ? assignment
      : Object.values(assignment);

    // Seed the error counter at 0 for each assigned partition so panels/alerts
    // render before the first real error (prom-client emits no series for a
    // labelled counter until it is incremented).
    for (const partition of partitions) {
      replayKafkaConsumeErrorsTotal.inc({ partition: String(partition) }, 0);
    }

    // Release lag gauges for partitions we owned before this rebalance but no
    // longer do, so the new owner is the only reporter.
    const assignedNow = new Set(partitions.map(Number));
    for (const prev of ownedPartitions) {
      if (!assignedNow.has(prev)) {
        replayKafkaConsumerLag.remove(String(prev));
      }
    }
    ownedPartitions = assignedNow;

    logger.info('replay kafka consumer joined group', {
      memberId: payload.memberId,
      groupId: payload.groupId,
      isLeader: payload.isLeader,
      partitions: partitions.length,
    });
  });
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    logger.error('replay kafka consumer crashed', {
      error: payload.error,
      groupId: payload.groupId,
      restart: payload.restart,
    });
  });
  consumer.on(consumer.events.DISCONNECT, () => {
    for (const prev of ownedPartitions) {
      replayKafkaConsumerLag.remove(String(prev));
    }
    ownedPartitions = new Set();
    logger.warn('replay kafka consumer disconnected');
  });

  await consumer.run({
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
      if (!isRunning() || isStale()) {
        return;
      }

      const partition = String(batch.partition);

      // Decompress every message into a JSONEachRow line. A single malformed /
      // undecompressable message is dropped-and-logged (it can never succeed on
      // redelivery, so blocking the partition on it would be worse) but still
      // gets its offset resolved below; a whole-batch insert failure is what we
      // refuse to resolve.
      const lines: string[] = [];
      let firstTraceparent: string | undefined;
      for (const m of batch.messages) {
        if (!m.value) {
          continue;
        }
        try {
          lines.push(decompressReplayLine(m.value));
          if (!firstTraceparent) {
            const tp = m.headers?.traceparent;
            if (tp) {
              firstTraceparent = tp.toString();
            }
          }
        } catch (err) {
          replayKafkaConsumeErrorsTotal.inc({ partition });
          logger.error('replay kafka message decompress failed', {
            error: err,
            partition: batch.partition,
            offset: m.offset,
          });
        }
      }

      if (lines.length > 0) {
        // Bind the CH insert to the originating /track trace (best-effort: use
        // the first message's traceparent so the batch insert shows up under a
        // real request in SigNoz) and stamp log_comment endpoint so the insert
        // is attributable in query_log.
        const parentCtx = contextFromTraceparent(firstTraceparent);
        // Keep the group session alive while the insert runs, and bound the
        // insert below sessionTimeout (see HEARTBEAT_EVERY_MS / INSERT_TIMEOUT_MS).
        await heartbeat();
        const keepAlive = setInterval(() => {
          heartbeat().catch(() => {
            // a failed heartbeat surfaces via the consumer's own events
          });
        }, HEARTBEAT_EVERY_MS);
        try {
          await context.with(parentCtx, () =>
            withQueryContext({ endpoint: 'worker.incomingReplay' }, () =>
              withSpan(
                'worker.incomingReplay',
                { attributes: { 'openpanel.replay_chunks': lines.length } },
                () =>
                  insertReplayChunks(lines, {
                    abortSignal: AbortSignal.timeout(INSERT_TIMEOUT_MS),
                  }),
              ),
            ),
          );
          replayKafkaConsumedTotal.inc({ partition }, lines.length);
        } catch (err) {
          // Do NOT resolve offsets — let kafkajs redeliver the batch. Replay is
          // loss-averse here (a redelivery duplicates at worst; Phase 1 accepts
          // that) and a persistent CH failure should surface as lag, not
          // silent loss.
          replayKafkaConsumeErrorsTotal.inc({ partition });
          logger.error('replay kafka batch insert failed', {
            error: err,
            partition: batch.partition,
            messages: batch.messages.length,
          });
          // Nothing in this batch was resolved, so lag runs from its first
          // offset. Setting it here keeps the gauge climbing during an outage
          // instead of freezing at the last successful value.
          replayKafkaConsumerLag.set(
            { partition },
            Math.max(
              0,
              Number(batch.highWatermark) - Number(batch.messages[0]!.offset),
            ),
          );
          return;
        } finally {
          clearInterval(keepAlive);
        }
      }

      // Insert succeeded (or the batch was all-empty/undecompressable) — resolve
      // every offset in the batch. batch.messages is ordered by offset.
      for (const m of batch.messages) {
        resolveOffset(m.offset);
      }

      // Lag = broker high-watermark − 1 − last committed offset.
      const lastOffset = batch.messages[batch.messages.length - 1]!.offset;
      replayKafkaConsumerLag.set(
        { partition },
        Math.max(0, Number(batch.highWatermark) - 1 - Number(lastOffset)),
      );

      await heartbeat();
    },
  });

  kafkaLogger.info('kafka replay consumer running', {
    topic: KAFKA_REPLAY_TOPIC,
    pod: POD,
  });

  return {
    stop: async () => {
      await consumer.disconnect();
    },
  };
}
