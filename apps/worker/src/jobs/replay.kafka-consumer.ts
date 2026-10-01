import {
  type ReplayLineWithOffset,
  insertReplayChunks,
  writeSessionReplayBlocks,
} from '@openpanel/db';
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
  replayBlocksBytesTotal,
  replayBlocksErrorsTotal,
  replayBlocksWrittenTotal,
  replayKafkaConsumeErrorsTotal,
  replayKafkaConsumedTotal,
  replayKafkaConsumerLag,
} from '../metrics';
import { logger } from '../utils/logger';

export interface ReplayKafkaConsumerHandle {
  stop: () => Promise<void>;
}

// Blob-primary write mode (Phase 2), env-gated so it ships inert:
//   off  (default) — insert chunks into ClickHouse only (Phase 1 behaviour)
//   dual           — ALSO write zstd blocks to Azure Blob + refs to CH
//   only           — write blocks only; STOP inserting chunk payloads into CH
// Flip via `kubectl set env` + rollout. Serving from blocks is a separate flag.
type ReplayBlocksMode = 'off' | 'dual' | 'only';
const REPLAY_BLOCKS_MODE: ReplayBlocksMode = ((): ReplayBlocksMode => {
  const v = (process.env.REPLAY_BLOCKS_MODE || 'off').trim().toLowerCase();
  return v === 'dual' || v === 'only' ? v : 'off';
})();

// Replay is MUCH simpler than the events consumer: a chunk is a self-contained
// row — there is no session read-modify-write to serialize, so we don't group by
// key and there's no dedup. A batch is: decompress every value → collect the
// JSONEachRow lines → write them (CH chunks and/or blob blocks per
// REPLAY_BLOCKS_MODE) → resolve the whole batch. On a decompress or write error
// we DON'T resolve, so kafkajs redelivers the batch (at-least-once) rather than
// dropping replay — a redelivery at worst duplicates (block refs collapse via
// ReplacingMergeTree; CH chunks de-dup at serving), it never loses a chunk.

// Heartbeat cadence within a large batch so a slow CH insert can't blow the
// 30s sessionTimeout. Replay batches are small in count (few, fat messages), so
// heartbeating around the insert is enough; kept for symmetry with events.
const POD = process.env.HOSTNAME || process.env.POD_NAME || 'unknown';

export async function startKafkaReplayConsumer(): Promise<ReplayKafkaConsumerHandle> {
  const consumer = createKafkaReplayConsumer();
  await consumer.connect();
  await consumer.subscribe({ topic: KAFKA_REPLAY_TOPIC, fromBeginning: false });

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
      // (line, kafka offset) pairs for the blocks path — block_index keys off the
      // offset of a session's first chunk (monotonic per session, dedup-stable).
      const linesWithOffsets: ReplayLineWithOffset[] = [];
      let firstTraceparent: string | undefined;
      for (const m of batch.messages) {
        if (!m.value) {
          continue;
        }
        try {
          const line = decompressReplayLine(m.value);
          lines.push(line);
          linesWithOffsets.push({ line, offset: Number(m.offset) });
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
        const doBlocks = REPLAY_BLOCKS_MODE !== 'off';
        const doCh = REPLAY_BLOCKS_MODE !== 'only';
        try {
          await context.with(parentCtx, () =>
            withQueryContext({ endpoint: 'worker.incomingReplay' }, () =>
              withSpan(
                'worker.incomingReplay',
                {
                  attributes: {
                    'openpanel.replay_chunks': lines.length,
                    'openpanel.replay_blocks_mode': REPLAY_BLOCKS_MODE,
                  },
                },
                async () => {
                  // Blob blocks first (its ref write is idempotent via
                  // ReplacingMergeTree); then the CH chunk insert. Either failing
                  // means we don't resolve → the batch redelivers.
                  if (doBlocks) {
                    try {
                      const { blocks, bytes } =
                        await writeSessionReplayBlocks(linesWithOffsets);
                      replayBlocksWrittenTotal.inc({ partition }, blocks);
                      replayBlocksBytesTotal.inc(bytes);
                    } catch (err) {
                      replayBlocksErrorsTotal.inc({ partition });
                      throw err;
                    }
                  }
                  if (doCh) {
                    await insertReplayChunks(lines);
                  }
                },
              ),
            ),
          );
          replayKafkaConsumedTotal.inc({ partition }, lines.length);
        } catch (err) {
          // Do NOT resolve offsets — let kafkajs redeliver the batch. Replay is
          // loss-averse here (a redelivery duplicates at worst) and a persistent
          // blob/CH failure should surface as lag, not silent loss.
          replayKafkaConsumeErrorsTotal.inc({ partition });
          logger.error('replay kafka batch write failed', {
            error: err,
            partition: batch.partition,
            messages: batch.messages.length,
            mode: REPLAY_BLOCKS_MODE,
          });
          return;
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
