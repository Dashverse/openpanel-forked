import { Readable } from 'node:stream';
import type { ClickHouseSettings } from '@clickhouse/client';
import { TABLE_NAMES, ch } from '../clickhouse/client';
import { BaseBuffer } from './base-buffer';

export interface IClickhouseSessionReplayChunk {
  project_id: string;
  session_id: string;
  /**
   * Client-generated per-tab / per-page-load UUID. Distinguishes chunks from
   * multiple recorders sharing the same session_id (multi-tab, refresh).
   * Empty string for chunks from older SDKs that don't send it — CH column
   * defaults to '' so the raw JSONEachRow passthrough stays valid either way.
   */
  window_id: string;
  chunk_index: number;
  started_at: string;
  ended_at: string;
  events_count: number;
  is_full_snapshot: boolean;
  payload: string;
}

const REPLAY_INSERT_CHUNK_SIZE = process.env.REPLAY_BUFFER_INSERT_CHUNK_SIZE
  ? Number.parseInt(process.env.REPLAY_BUFFER_INSERT_CHUNK_SIZE, 10)
  : 50;
const REPLAY_INSERT_CONCURRENCY = process.env.BUFFER_CH_INSERT_CONCURRENCY
  ? Number.parseInt(process.env.BUFFER_CH_INSERT_CONCURRENCY, 10)
  : 5;

function replayClickhouseSettings(): ClickHouseSettings {
  if (process.env.BUFFER_ASYNC_INSERTS) {
    return {
      async_insert: 1,
      wait_for_async_insert: 0,
      parallel_view_processing: 1,
    };
  }
  return {};
}

/**
 * Insert already-serialized JSONEachRow replay-chunk lines into ClickHouse,
 * sub-chunked + concurrency-bounded — the exact insert `ReplayBuffer` does,
 * lifted to a free function so BOTH the Redis flush AND the Kafka replay
 * consumer produce byte-identical `session_replay_chunks` rows. Each line MUST
 * be `JSON.stringify(chunk)` of an `IClickhouseSessionReplayChunk`.
 */
export async function insertReplayChunks(rawLines: string[]): Promise<void> {
  if (rawLines.length === 0) return;
  const settings = replayClickhouseSettings();
  const groups: string[][] = [];
  for (let i = 0; i < rawLines.length; i += REPLAY_INSERT_CHUNK_SIZE) {
    groups.push(rawLines.slice(i, i + REPLAY_INSERT_CHUNK_SIZE));
  }
  const runOne = (group: string[]): Promise<unknown> =>
    ch.insert({
      table: TABLE_NAMES.session_replay_chunks,
      values: Readable.from(
        (function* () {
          for (const line of group) yield line;
        })(),
      ),
      format: 'JSONEachRow',
      clickhouse_settings: settings,
    });
  const concurrency = Math.max(1, REPLAY_INSERT_CONCURRENCY);
  if (concurrency <= 1 || groups.length === 1) {
    for (const g of groups) await runOne(g);
    return;
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = next++;
      if (idx >= groups.length) return;
      await runOne(groups[idx]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, groups.length) }, () => worker()),
  );
}

export class ReplayBuffer extends BaseBuffer {
  private batchSize = process.env.REPLAY_BUFFER_BATCH_SIZE
    ? Number.parseInt(process.env.REPLAY_BUFFER_BATCH_SIZE, 10)
    : 500;

  // Cluster-safe hash tag keeps key on the same Redis slot across cluster nodes
  private readonly redisKey = '{replay_buffer}:chunks';
  protected bufferCounterKey = '{replay_buffer}:count';

  constructor() {
    super({
      name: 'replay',
      onFlush: async () => {
        await this.processBuffer();
      },
    });
  }

  async add(chunk: IClickhouseSessionReplayChunk) {
    return this.timeAdd(async () => {
      try {
        const result = await this.redis
          .multi()
          .rpush(this.redisKey, JSON.stringify(chunk))
          .incr(this.bufferCounterKey)
          .llen(this.redisKey)
          .exec();

        const bufferLength = (result?.[2]?.[1] as number) ?? 0;
        if (bufferLength >= this.batchSize) {
          await this.tryFlush({ trigger: 'add' });
        }
      } catch (error) {
        this.logger.error('Failed to add replay chunk to buffer', { error });
      }
    });
  }

  async processBuffer() {
    const lrangeStart = performance.now();
    const items = await this.redis.lrange(this.redisKey, 0, this.batchSize - 1);
    const lrangeMs = performance.now() - lrangeStart;

    if (items.length === 0) {
      this.reportFlushStats({ rowsProcessed: 0, phases: { lrangeMs } });
      return;
    }

    // Raw passthrough: each Redis entry is already a valid JSONEachRow
    // line (we JSON.stringify a single chunk before rpush). Streaming the
    // raw strings to CH skips JSON.parse × N on the worker AND the
    // client's internal JSON.stringify × N — significant because each
    // rrweb chunk's `payload` is 200KB–1MB.
    const chStart = performance.now();
    await insertReplayChunks(items);
    const chInsertMs = performance.now() - chStart;

    const trimStart = performance.now();
    await this.redis
      .multi()
      .ltrim(this.redisKey, items.length, -1)
      .decrby(this.bufferCounterKey, items.length)
      .exec();
    const trimMs = performance.now() - trimStart;

    this.reportFlushStats({
      rowsProcessed: items.length,
      phases: { lrangeMs, chInsertMs, trimMs },
    });

    this.logger.debug('Processed replay chunks', { count: items.length });
  }

  async getBufferSize() {
    return this.getBufferSizeWithCounter(() => this.redis.llen(this.redisKey));
  }

  async getBufferBytes() {
    return (await this.redis.memory('USAGE', this.redisKey)) ?? 0;
  }
}
