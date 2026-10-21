import {
  type ReplayLineWithOffset,
  insertReplayChunks,
  isReplayBlockStoreConfigured,
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
  replayBlobOnlyChunksTotal,
  replayBlocksBytesTotal,
  replayBlocksErrorsTotal,
  replayBlocksFailClosedTotal,
  replayBlocksShadowSkippedTotal,
  replayBlocksSkippedChunksTotal,
  replayBlocksWrittenTotal,
  replayKafkaBatchRetriesTotal,
  replayKafkaConsumeErrorsTotal,
  replayKafkaConsumedTotal,
  replayKafkaConsumerLag,
} from '../metrics';
import { logger } from '../utils/logger';
import {
  type ReplayBlocksMode,
  parseBlobOnlyProjectIds,
  positiveIntEnv,
  replayRetryBackoffMs,
  writeReplayBatch,
} from './replay-batch-writer';

export interface ReplayKafkaConsumerHandle {
  stop: () => Promise<void>;
}

// Blob-primary write mode (Phase 2), env-gated so it ships inert:
//   off  (default) — insert chunks into ClickHouse only (Phase 1 behaviour)
//   dual           — ALSO write zstd blocks to Azure Blob + refs to CH, as a
//                    SHADOW write: the CH chunk insert stays the source of truth,
//                    a blob/ref failure is counted + logged but never blocks it.
// Per-project Blob-only (REPLAY_BLOB_ONLY_PROJECT_IDS, CSV) skips the CH insert
// for those projects: blocks are their only copy, so a block/ref failure fails
// the batch (redelivery) instead of being swallowed. Requires mode=dual (which
// requires the blob store); otherwise those projects keep writing CH. Turn it
// on only for projects the API serves from blocks
// (REPLAY_SERVE_BLOCKS_PROJECT_IDS), or their new replays won't list/play.
// Flip via `kubectl set env` + rollout.
const REPLAY_BLOCKS_MODE: ReplayBlocksMode = ((): ReplayBlocksMode => {
  const v = (process.env.REPLAY_BLOCKS_MODE || 'off').trim().toLowerCase();
  if (v === 'dual') {
    if (!isReplayBlockStoreConfigured()) {
      // Not fatal: a missing blob config must never take the consumer (and the
      // events consumer on the same pod) down — run Phase 1 behaviour instead.
      logger.error(
        'REPLAY_BLOCKS_MODE=dual but AZURE_BLOB_CONNECTION_STRING is not set; replay blocks disabled (mode=off)',
      );
      return 'off';
    }
    return 'dual';
  }
  if (v !== 'off') {
    logger.warn('Unsupported REPLAY_BLOCKS_MODE; using off', { value: v });
  }
  return 'off';
})();
const REPLAY_BLOB_ONLY_PROJECT_IDS: ReadonlySet<string> = (() => {
  const ids = parseBlobOnlyProjectIds(process.env.REPLAY_BLOB_ONLY_PROJECT_IDS);
  if (ids.size > 0 && REPLAY_BLOCKS_MODE !== 'dual') {
    // Never write nowhere: without blocks these projects stay on CH.
    logger.error(
      'REPLAY_BLOB_ONLY_PROJECT_IDS is set but replay blocks are off (needs REPLAY_BLOCKS_MODE=dual + AZURE_BLOB_CONNECTION_STRING); writing ClickHouse for those projects',
      { projects: Array.from(ids) },
    );
    return new Set<string>();
  }
  if (ids.size > 0) {
    // These replays exist only in blocks: the API must serve them from
    // blocks, which it does when the same REPLAY_BLOB_ONLY_PROJECT_IDS is
    // set on it too.
    logger.info(
      'replay Blob-only projects (no ClickHouse chunk insert); set the same REPLAY_BLOB_ONLY_PROJECT_IDS on the API so they are served',
      { projects: Array.from(ids) },
    );
  }
  return ids;
})();

// Overall bound on one batch's blob appends + ref insert. With the CH insert's
// own INSERT_TIMEOUT_MS this keeps a batch well inside the rebalance timeout.
// A non-positive/non-numeric value falls back to the default: NaN would make
// AbortSignal.timeout throw on every batch (silently, inside the shadow catch).
const BLOCKS_TIMEOUT_MS = positiveIntEnv(
  process.env.REPLAY_BLOCKS_TIMEOUT_MS,
  20_000,
);

// One deadline for the whole batch (Blob-only write + CH insert + shadow
// write). The per-step timeouts alone add up to 65s, past kafkajs' default 60s
// rebalance timeout. The shadow write is skipped when less than
// SHADOW_MIN_BUDGET_MS is left: it's optional, and skipping it only means those
// sessions serve from ClickHouse.
const BATCH_DEADLINE_MS = positiveIntEnv(
  process.env.REPLAY_KAFKA_BATCH_DEADLINE_MS,
  45_000,
);
const SHADOW_MIN_BUDGET_MS = 5_000;
// Longest pause before a failed batch is retried (exponential from 1s).
const RETRY_BACKOFF_MAX_MS = positiveIntEnv(
  process.env.REPLAY_KAFKA_RETRY_BACKOFF_MAX_MS,
  30_000,
);

// Replay is MUCH simpler than the events consumer: a chunk is a self-contained
// row — there is no session read-modify-write to serialize, so we don't group by
// key and there's no dedup. A batch is: decompress every value → collect the
// JSONEachRow lines → insert the CH chunks (then, in dual mode, shadow-write
// blob blocks; Blob-only projects get blocks only, fail-closed - see
// replay-batch-writer.ts) → resolve the whole batch. On a CH insert or
// Blob-only block error we
// DON'T resolve, so kafkajs redelivers the batch (at-least-once) rather than
// dropping replay — a redelivery at worst duplicates (CH chunks and block refs
// are both de-duped by chunk at serving), it never loses a chunk.

const POD = process.env.HOSTNAME || process.env.POD_NAME || 'unknown';

// A fat-payload insert can outlast the 30s consumer sessionTimeout (the CH
// client's own request timeout is 1h), which would get this member kicked and
// the batch reprocessed on another pod. So while an insert is in flight we
// heartbeat every HEARTBEAT_EVERY_MS, and abort the insert after INSERT_TIMEOUT_MS
// (below sessionTimeout) — a timed-out insert takes the normal failure path.
const HEARTBEAT_EVERY_MS = 3_000;
const INSERT_TIMEOUT_MS = positiveIntEnv(
  process.env.REPLAY_KAFKA_INSERT_TIMEOUT_MS,
  25_000,
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
  // Consecutive failures of the batch at the head of each partition (keyed by
  // its first offset), for the retry backoff. Reset when that batch succeeds.
  const failures = new Map<number, { offset: string; attempts: number }>();

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
      replayKafkaBatchRetriesTotal.inc({ partition: String(partition) }, 0);
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
    for (const p of failures.keys()) {
      if (!assignedNow.has(p)) failures.delete(p);
    }

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
        // Keep the group session alive while the writes run (CH + blob), and
        // bound each below the rebalance timeout (INSERT_TIMEOUT_MS /
        // BLOCKS_TIMEOUT_MS).
        await heartbeat();
        const batchStarted = Date.now();
        const deadline = AbortSignal.timeout(BATCH_DEADLINE_MS);
        const stepSignal = (ms: number) =>
          AbortSignal.any([deadline, AbortSignal.timeout(ms)]);
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
                {
                  attributes: {
                    'openpanel.replay_chunks': lines.length,
                    'openpanel.replay_blocks_mode': REPLAY_BLOCKS_MODE,
                  },
                },
                async () => {
                  // CH chunks (dual/off projects) are the source of truth and
                  // Blob-only projects' blocks are their only copy: a failure
                  // of either throws → we don't resolve → the batch
                  // redelivers. Dual projects' blocks are a shadow write: an
                  // Azure outage or slow call must not stall live replay, so
                  // those errors are counted + logged, never thrown.
                  const res = await writeReplayBatch(
                    linesWithOffsets,
                    {
                      mode: REPLAY_BLOCKS_MODE,
                      blobOnlyProjectIds: REPLAY_BLOB_ONLY_PROJECT_IDS,
                    },
                    {
                      insertChunks: (chLines) =>
                        insertReplayChunks(chLines, {
                          abortSignal: stepSignal(INSERT_TIMEOUT_MS),
                        }),
                      writeBlocks: async (items) => {
                        const r = await writeSessionReplayBlocks(items, {
                          abortSignal: stepSignal(BLOCKS_TIMEOUT_MS),
                        });
                        if (r.skipped) {
                          replayBlocksSkippedChunksTotal.inc(
                            { partition },
                            r.skipped,
                          );
                        }
                        return r;
                      },
                      shadowBudgetOk: () =>
                        BATCH_DEADLINE_MS - (Date.now() - batchStarted) >=
                        SHADOW_MIN_BUDGET_MS,
                      onShadowSkipped: () => {
                        replayBlocksShadowSkippedTotal.inc({ partition });
                        logger.warn(
                          'replay shadow block write skipped (batch deadline)',
                          { partition: batch.partition },
                        );
                      },
                      onShadowError: (err) => {
                        replayBlocksErrorsTotal.inc({ partition });
                        logger.error(
                          'replay blob blocks write failed (shadow)',
                          {
                            error: err,
                            partition: batch.partition,
                            messages: batch.messages.length,
                          },
                        );
                      },
                      onFailClosed: (err) => {
                        replayBlocksErrorsTotal.inc({ partition });
                        replayBlocksFailClosedTotal.inc({ partition });
                        logger.error(
                          'replay blob blocks write failed (blob-only, batch will redeliver)',
                          {
                            error: err,
                            partition: batch.partition,
                            messages: batch.messages.length,
                          },
                        );
                      },
                    },
                  );
                  if (res.blocks > 0) {
                    replayBlocksWrittenTotal.inc({ partition }, res.blocks);
                    replayBlocksBytesTotal.inc(res.bytes);
                  }
                  if (res.blobOnlyChunks > 0) {
                    replayBlobOnlyChunksTotal.inc(
                      { partition },
                      res.blobOnlyChunks,
                    );
                  }
                },
              ),
            ),
          );
          replayKafkaConsumedTotal.inc({ partition }, lines.length);
        } catch (err) {
          // Do NOT resolve offsets — let kafkajs redeliver the batch. Replay is
          // loss-averse here (a redelivery duplicates at worst) and a persistent
          // CH failure should surface as lag, not silent loss.
          replayKafkaConsumeErrorsTotal.inc({ partition });
          logger.error('replay kafka batch write failed', {
            error: err,
            partition: batch.partition,
            messages: batch.messages.length,
            mode: REPLAY_BLOCKS_MODE,
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
          // Back off before the redelivery: pause this partition (other
          // partitions keep flowing) and resume after 1s, 2s, 4s ... capped.
          // Without this an outage re-fetched and re-failed the batch in a
          // hot loop.
          const firstOffset = batch.messages[0]!.offset;
          const prev = failures.get(batch.partition);
          const attempts =
            prev && prev.offset === firstOffset ? prev.attempts + 1 : 1;
          failures.set(batch.partition, { offset: firstOffset, attempts });
          const backoffMs = replayRetryBackoffMs(
            attempts,
            RETRY_BACKOFF_MAX_MS,
          );
          replayKafkaBatchRetriesTotal.inc({ partition });
          const tp = [{ topic: batch.topic, partitions: [batch.partition] }];
          consumer.pause(tp);
          setTimeout(() => consumer.resume(tp), backoffMs).unref();
          logger.warn('replay kafka partition paused before retry', {
            partition: batch.partition,
            offset: firstOffset,
            attempts,
            backoffMs,
          });
          return;
        } finally {
          clearInterval(keepAlive);
        }
      }

      // Insert succeeded (or the batch was all-empty/undecompressable) — resolve
      // every offset in the batch. batch.messages is ordered by offset.
      failures.delete(batch.partition);
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
