import { getSafeJson } from '@openpanel/json';
import { getRedisCache } from '@openpanel/redis';

import { TABLE_NAMES, ch } from '../clickhouse/client';
import { BaseBuffer } from './base-buffer';

export interface IClickhouseAlias {
  project_id: string;
  profile_id: string;
  alias: string;
  created_at: string;
}

/**
 * Batches `profile_aliases` writes instead of inserting one row per identity
 * resolution.
 *
 * The mixpanel-proxy re-emits the same `(anonymous id -> identified id)` mapping
 * on every event batch, so the direct-insert path (upsertAlias) produced a part
 * per re-emission and a flood of duplicate rows into the `profile_aliases`
 * ReplacingMergeTree — which then burned enormous merge CPU re-collapsing them
 * (observed: ~1M merges / ~16B rows merged in 2 days to hold ~4M rows).
 *
 * This buffer fixes both halves without any per-write existence check:
 *  - app-side batching -> far fewer, bigger parts (fewer merges), and
 *  - in-batch dedup on flush -> the repeated identical mappings within a flush
 *    window collapse to a single row before they ever reach ClickHouse.
 *
 * Durability note: buffered aliases live in the cache Redis only, but the proxy
 * re-emits each mapping on the next batch anyway, so a dropped buffer entry is
 * self-healing on the following event.
 */
export class AliasBuffer extends BaseBuffer {
  private batchSize = process.env.ALIAS_BUFFER_BATCH_SIZE
    ? Number.parseInt(process.env.ALIAS_BUFFER_BATCH_SIZE, 10)
    : 500;

  private chunkSize = process.env.ALIAS_BUFFER_CHUNK_SIZE
    ? Number.parseInt(process.env.ALIAS_BUFFER_CHUNK_SIZE, 10)
    : 1000;

  // Hash-tagged so the list and its counter share a Redis Cluster slot (the
  // rpush + incr run in one MULTI).
  private readonly redisKey = '{alias_buffer}:aliases';
  protected bufferCounterKey = '{alias_buffer}:count';

  constructor() {
    super({
      name: 'alias',
      onFlush: async () => {
        await this.processBuffer();
      },
      redis: getRedisCache(),
    });
  }

  async add(alias: IClickhouseAlias) {
    try {
      await this.redis
        .multi()
        .rpush(this.redisKey, JSON.stringify(alias))
        .incr(this.bufferCounterKey)
        .exec();

      const bufferLength = await this.getBufferSize();
      if (bufferLength >= this.batchSize) {
        await this.tryFlush();
      }
    } catch (error) {
      this.logger.error('Failed to add alias', { error });
    }
  }

  async processBuffer() {
    try {
      const rows = await this.redis.lrange(
        this.redisKey,
        0,
        this.batchSize - 1,
      );

      if (rows.length === 0) {
        return;
      }

      const parsed = rows
        .map((r) => getSafeJson<IClickhouseAlias>(r))
        .filter((r): r is IClickhouseAlias => r !== null);

      // In-batch dedup: the proxy re-emits the same mapping on every event
      // batch, so within a flush window the same (project_id, alias, profile_id)
      // appears many times. Collapse to one row (keeping the latest) before
      // insert — this is what actually cuts the ReplacingMergeTree merge churn,
      // with zero external lookups.
      const deduped = new Map<string, IClickhouseAlias>();
      for (const row of parsed) {
        deduped.set(`${row.project_id}|${row.alias}|${row.profile_id}`, row);
      }
      const values = [...deduped.values()];

      const chInsertStart = performance.now();
      for (const chunk of this.chunks(values, this.chunkSize)) {
        await ch.insert({
          table: TABLE_NAMES.alias,
          values: chunk,
          format: 'JSONEachRow',
          // async_insert lets CH coalesce across flushes too; harmless on top of
          // the app-side batching and matches the original direct-insert path.
          clickhouse_settings: {
            async_insert: 1,
            wait_for_async_insert: 0,
          },
        });
      }

      // Report the deduped rows actually inserted so
      // buffer_rows_inserted_total{buffer="alias"} + the flush-duration phase
      // breakdown populate — matching the event and replay buffers.
      this.reportFlushStats({
        rowsProcessed: values.length,
        phases: { chInsertMs: performance.now() - chInsertStart },
      });

      // Only trim after a successful insert so a failed flush is retried.
      await this.redis
        .multi()
        .ltrim(this.redisKey, rows.length, -1)
        .decrby(this.bufferCounterKey, rows.length)
        .exec();

      this.logger.debug('Processed aliases', {
        read: rows.length,
        inserted: values.length,
        collapsed: rows.length - values.length,
      });
    } catch (error) {
      this.logger.error('Failed to process alias buffer', { error });
    }
  }

  async getBufferSize() {
    return this.getBufferSizeWithCounter(() => this.redis.llen(this.redisKey));
  }

  async getBufferBytes() {
    return (await this.redis.memory('USAGE', this.redisKey)) ?? 0;
  }
}
