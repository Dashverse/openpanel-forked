/**
 * Integration check for split replay chunks (transport parts) against a LOCAL
 * Redpanda with a 1 MB message cap. Uses the real producer code
 * (produceReplayChunk), the real replay consumer config
 * (createKafkaReplayConsumer) and the worker's reassembly (reassembleReplayBatch).
 * Writes nothing anywhere except the local broker.
 *
 *   docker run -d --name it-redpanda-parts -p 127.0.0.1:19092:19092 \
 *     docker.redpanda.com/redpandadata/redpanda:v24.2.7 redpanda start \
 *     --mode dev-container --smp 1 --kafka-addr PLAINTEXT://0.0.0.0:19092 \
 *     --advertise-kafka-addr PLAINTEXT://127.0.0.1:19092
 *   docker exec it-redpanda-parts rpk cluster config set kafka_batch_max_bytes 1048576
 *   env -i PATH="$PATH" HOME="$HOME" KAFKA_BROKERS=127.0.0.1:19092 \
 *     npx tsx scripts/replay-parts-redpanda.ts
 *
 * Creates (and deletes) a fresh topic per run. Refuses to run unless every
 * broker is localhost and no SASL / Event Hubs env is set (env -i keeps the
 * shell's env out; nothing here loads .env).
 */
import { randomBytes, randomUUID } from 'node:crypto';

const brokers = (process.env.KAFKA_BROKERS || '').split(',').filter(Boolean);
if (
  brokers.length === 0 ||
  !brokers.every((b) => /^(localhost|127\.0\.0\.1):\d+$/.test(b.trim())) ||
  process.env.KAFKA_SASL_MECHANISM ||
  process.env.KAFKA_SASL_USERNAME ||
  process.env.KAFKA_SASL_PASSWORD ||
  process.env.EVENTHUB_CONNECTION_STRING
) {
  console.error(
    'refusing: KAFKA_BROKERS must be localhost only, no SASL/EventHub env',
  );
  process.exit(2);
}
process.env.KAFKA_SSL = 'false';
process.env.REPLAY_KAFKA_SPLIT_ENABLED = '1';
// lz4 (default) or zstd, passed through from the caller.
const CODEC = process.env.REPLAY_KAFKA_CODEC === 'zstd' ? 'zstd' : 'lz4';
process.env.KAFKA_REPLAY_CONSUMER_GROUP = `it-replay-parts-${Date.now()}`;

// Fresh topic per run (1 MB message cap), so earlier runs can't leak in.
const T = `${process.env.KAFKA_REPLAY_TOPIC || 'it-replay-parts'}-${Date.now()}`;
process.env.KAFKA_REPLAY_TOPIC = T;

async function main() {
  const q = await import('../../../packages/queue/src/replay-kafka');
  const { getKafka } = await import('../../../packages/queue/src/kafka');
  const { reassembleReplayBatch } = await import('../src/jobs/replay-parts');
  if (q.KAFKA_REPLAY_TOPIC !== T) throw new Error('topic env not applied');

  const chunk = (session: string, idx: number, payload: string) => ({
    project_id: 'it',
    session_id: session,
    window_id: 'w',
    chunk_index: idx,
    started_at: '2026-10-19 10:00:00.000',
    ended_at: '2026-10-19 10:00:01.000',
    events_count: 1,
    is_full_snapshot: idx === 0,
    payload,
  });
  // Incompressible: ~2.6 MB after LZ4 → 3 parts of <= 950000.
  const big = chunk('sess-big', 0, randomBytes(1_950_000).toString('base64'));
  const smalls = Array.from({ length: 30 }, (_, i) =>
    chunk(i % 2 ? 'sess-big' : `sess-${i}`, i + 1, `[{"type":3,"i":${i}}]`),
  );

  const admin = getKafka().admin();
  await admin.connect();
  await admin.createTopics({
    waitForLeaders: true,
    topics: [
      {
        topic: T,
        numPartitions: 3,
        configEntries: [{ name: 'max.message.bytes', value: '1048576' }],
      },
    ],
  });

  // 0. Control: the broker really rejects > 1 MB in one request.
  const raw = getKafka().producer();
  await raw.connect();
  let rejected = false;
  try {
    await raw.send({
      topic: T,
      messages: [0, 1, 2].map(() => ({
        key: 'ctl',
        value: randomBytes(600_000),
      })),
    });
  } catch (err) {
    rejected = true;
    console.log(
      'control: 3 x 600 KB in one send rejected:',
      (err as Error).message,
    );
  }
  if (!rejected)
    console.log('control: WARNING, 1.8 MB single send was accepted');

  // 1. Big chunk via the real producer, concurrently with small ones on the
  // same and other keys (interleaving between parts).
  const results = await Promise.all([
    q.produceReplayChunk(big as any, 'sess-big'),
    ...smalls.map((c) => q.produceReplayChunk(c as any, c.session_id)),
  ]);
  console.log('big produce result:', results[0]);

  // 2. An orphan set (parts 0,1 of 3, produced 200s "ago") followed by a fresh
  // message on the same key: must be dropped as abandoned, not stall.
  const old = Date.now() - 200_000;
  const orphanId = randomUUID();
  for (const i of [0, 1]) {
    await raw.send({
      topic: T,
      messages: [
        {
          key: 'sess-orphan',
          value: randomBytes(1000),
          timestamp: String(old + i),
          headers: {
            'x-replay-chunk-id': orphanId,
            'x-replay-part': String(i),
            'x-replay-parts': '3',
          },
        },
      ],
    });
  }
  const after = chunk('sess-orphan', 99, '[{"type":3,"after":true}]');
  await q.produceReplayChunk(after as any, 'sess-orphan');

  // 3. Consume with the real replay consumer config + worker reassembly.
  const expected = new Set(
    [big, ...smalls, after].map((c) => JSON.stringify(c)),
  );
  const seen = new Map<string, number>();
  const dropped: unknown[] = [];
  let reassembled = 0;
  const consumer = q.createKafkaReplayConsumer();
  await consumer.connect();
  await consumer.subscribe({ topic: T, fromBeginning: true });
  let waits = 0;
  void consumer.run({
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset }) => {
      const r = reassembleReplayBatch(batch.messages, {
        decode: q.decodeReplayValue,
        maxParts: 32,
        abandonAfterMs: 120_000,
        atTail:
          Number(batch.messages[batch.messages.length - 1]!.offset) >=
          Number(batch.highWatermark) - 1,
        maxBytesPerPartition: q.REPLAY_KAFKA_MAX_BYTES_PER_PARTITION,
        maxMessageBytes: q.REPLAY_KAFKA_MAX_BYTES,
        headBlockedMs: 0,
        maxHeadBlockedMs: 600_000,
      });
      for (const l of r.lines) seen.set(l.line, (seen.get(l.line) ?? 0) + 1);
      reassembled += r.reassembled;
      dropped.push(...r.dropped);
      if (r.resolveThrough !== null) resolveOffset(r.resolveThrough);
      if (r.blockedAt === batch.messages[0]!.offset) {
        // same as the worker: pause briefly, refetch from the head
        waits++;
        const tp = [{ topic: batch.topic, partitions: [batch.partition] }];
        consumer.pause(tp);
        setTimeout(() => consumer.resume(tp), 250).unref();
      }
      console.log(
        `batch p${batch.partition} ${batch.firstOffset()}..${batch.lastOffset()} msgs=${batch.messages.length} lines=${r.lines.length} reassembled=${r.reassembled} resolve=${r.resolveThrough} blocked=${r.blockedAt} dropped=${r.dropped.map((d) => d.reason).join(',')}`,
      );
    },
  });
  const waitAll = async () => {
    const until = Date.now() + 30_000;
    while (![...expected].every((e) => seen.has(e))) {
      if (Date.now() > until) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  await waitAll();

  // 4. Live tail: the consumer is caught up; send a split chunk's parts by
  // hand with a 2s gap before the last one, between other messages on the
  // same key. The consumer must wait (blocked at head), not drop or skip.
  const live = chunk('sess-live', 0, randomBytes(1_500_000).toString('base64'));
  const liveParts = (
    await import('../../../packages/queue/src/replay-parts')
  ).splitReplayValue(
    q.encodeReplayLine(JSON.stringify(live)),
    q.REPLAY_KAFKA_MAX_BYTES,
  );
  const liveId = randomUUID();
  const sendPart = (i: number) =>
    raw.send({
      topic: T,
      messages: [
        {
          key: 'sess-live',
          value: liveParts[i]!,
          headers: {
            'content-encoding': CODEC,
            'x-replay-chunk-id': liveId,
            'x-replay-part': String(i),
            'x-replay-parts': String(liveParts.length),
          },
        },
      ],
    });
  const between = chunk('sess-live', 1, '[{"type":3,"between":true}]');
  expected.add(JSON.stringify(live));
  expected.add(JSON.stringify(between));
  const waitsBefore = waits;
  for (let i = 0; i < liveParts.length - 1; i++) await sendPart(i);
  await q.produceReplayChunk(between as any, 'sess-live');
  await new Promise((r) => setTimeout(r, 2000));
  await sendPart(liveParts.length - 1);
  await waitAll();
  console.log(
    'live tail: parts',
    liveParts.length,
    'waits',
    waits - waitsBefore,
  );
  if (waits - waitsBefore < 1) throw new Error('expected the consumer to wait');
  await raw.disconnect();
  await consumer.disconnect();
  await admin.deleteTopics({ topics: [T] });
  await admin.disconnect();

  const missing = [...expected].filter((e) => !seen.has(e)).length;
  const dupes = [...seen.values()].filter((n) => n > 1).length;
  const bigOk = seen.get(JSON.stringify(big)) === 1;
  console.log({
    bigBytesLine: JSON.stringify(big).length,
    reassembled,
    missing,
    dupes,
    bigOk,
    dropped,
  });
  if (missing || dupes || !bigOk || reassembled !== 2) process.exit(1);
  console.log('OK');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
