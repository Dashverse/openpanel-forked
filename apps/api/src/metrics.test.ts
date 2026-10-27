import { beforeEach, describe, expect, it } from 'vitest';
import {
  recordReplayProduceResult,
  replayKafkaChunksSplitTotal,
  replayKafkaDroppedTotal,
  replayKafkaOverLimitBytes,
  replayKafkaPartsProducedTotal,
  replayKafkaProducedTotal,
} from './metrics';

const value = async (
  metric: {
    get: () => Promise<{
      values: { value: number; labels: object; metricName?: string }[];
    }>;
  },
  match: (v: {
    labels: Record<string, unknown>;
    metricName?: string;
  }) => boolean = () => true,
) =>
  (await metric.get()).values
    .filter((v) => match(v as never))
    .reduce((a, v) => a + v.value, 0);

const overLimit = (outcome: string, full: string, suffix: '_count' | '_sum') =>
  value(
    replayKafkaOverLimitBytes as never,
    (v) =>
      v.metricName === `replay_kafka_over_limit_bytes${suffix}` &&
      v.labels.outcome === outcome &&
      v.labels.is_full_snapshot === full,
  );

beforeEach(() => {
  replayKafkaProducedTotal.reset();
  replayKafkaChunksSplitTotal.reset();
  replayKafkaPartsProducedTotal.reset();
  replayKafkaDroppedTotal.reset();
  replayKafkaOverLimitBytes.reset();
});

describe('recordReplayProduceResult', () => {
  it('a single-message chunk counts as produced only (no over-limit size)', async () => {
    recordReplayProduceResult(
      { status: 'produced', compressedBytes: 1000, parts: 1 },
      true,
    );
    expect(await value(replayKafkaProducedTotal as never)).toBe(1);
    expect(await value(replayKafkaChunksSplitTotal as never)).toBe(0);
    expect(await overLimit('split', 'true', '_count')).toBe(0);
  });

  it('a split chunk records its size with outcome=split', async () => {
    recordReplayProduceResult(
      { status: 'produced', compressedBytes: 2_100_000, parts: 3 },
      true,
    );
    expect(await value(replayKafkaProducedTotal as never)).toBe(1);
    expect(await value(replayKafkaChunksSplitTotal as never)).toBe(1);
    expect(await value(replayKafkaPartsProducedTotal as never)).toBe(3);
    expect(await overLimit('split', 'true', '_count')).toBe(1);
    expect(await overLimit('split', 'true', '_sum')).toBe(2_100_000);
  });

  it('an oversize chunk records its size with outcome=dropped and counts the drop', async () => {
    recordReplayProduceResult(
      { status: 'oversize', compressedBytes: 4_000_000, parts: 0 },
      false,
    );
    expect(
      await value(
        replayKafkaDroppedTotal as never,
        (v) => v.labels.reason === 'oversize',
      ),
    ).toBe(1);
    expect(await value(replayKafkaProducedTotal as never)).toBe(0);
    expect(await overLimit('dropped', 'false', '_count')).toBe(1);
    expect(await overLimit('dropped', 'false', '_sum')).toBe(4_000_000);
    expect(await overLimit('split', 'false', '_count')).toBe(0);
  });
});
