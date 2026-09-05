import type { FinalChart, IChartSerie } from '@openpanel/validation';
import { describe, expect, it } from 'vitest';
import { compareOverall } from './compare-overall';

const serie = (
  id: string,
  event: string,
  counts: number[],
  previous?: number[],
): IChartSerie => ({
  id,
  names: [event, id],
  event: { id: event, name: event },
  metrics: {
    sum: counts.reduce((a, b) => a + b, 0),
    average: 0,
    min: 0,
    max: 0,
    count: undefined,
    previous: previous
      ? {
          average: undefined,
          min: undefined,
          max: undefined,
          count: undefined,
          sum: {
            value: previous.reduce((a, b) => a + b, 0),
            diff: null,
            state: 'neutral',
          },
        }
      : undefined,
  },
  data: counts.map((count, i) => ({
    date: `day-${i}`,
    count,
    previous: previous
      ? { value: previous[i]!, diff: null, state: 'neutral' }
      : undefined,
  })),
});
const chart = (...series: IChartSerie[]): FinalChart => ({
  series,
  metrics: series[0]!.metrics,
});

describe('compareOverall', () => {
  it('uses each event’s full denominator, independent of displayed breakdowns and series order', () => {
    const input = chart(
      serie('hin', 'A', [30, 10]),
      serie('ios', 'B', [20, 40]),
    );
    const total = chart(serie('B', 'B', [40, 200]), serie('A', 'A', [100, 50]));
    input.series[0]!.metrics.count = 27;
    const result = compareOverall(input, total);
    expect(result.series[0]!.metrics.count).toBe(27);
    expect(result.series.map((s) => s.data.map((d) => d.count))).toEqual([
      [0.3, 0.2],
      [0.5, 0.2],
    ]);
    expect(result.series[0]!.metrics.sum).toBeCloseTo(40 / 150);
    expect(input.series[0]!.data[0]!.count).toBe(30);
  });
  it('matches dates and normalizes previous periods separately; empty totals stay finite', () => {
    const input = chart(serie('hin', 'A', [20, 5], [10, 2]));
    const total = chart(serie('A', 'A', [100, 0], [20, 0]));
    total.series[0]!.data.reverse();
    const result = compareOverall(input, total).series[0]!;
    expect(result.data[0]!.count).toBe(0.2);
    expect(result.data[0]!.previous?.value).toBe(0.5);
    expect(result.data[1]!.count).toBe(0);
    expect(result.data[1]!.previous?.value).toBe(0);
    expect(result.metrics.previous?.sum?.value).toBeCloseTo(12 / 20);
  });
  it('uses full previous-period totals and keeps Unique absolute', () => {
    const input = chart(serie('hin', 'A', [20], [10, 15]));
    const total = chart(serie('A', 'A', [100], [20, 80]));
    input.series[0]!.metrics.count = 8;
    input.series[0]!.metrics.previous!.count = {
      value: 5,
      diff: 60,
      state: 'positive',
    };
    const result = compareOverall(input, total).series[0]!;
    expect(result.metrics.previous?.sum?.value).toBe(0.25);
    expect(result.metrics.count).toBe(8);
    expect(result.metrics.previous?.count).toEqual(
      input.series[0]!.metrics.previous!.count,
    );
    expect(
      compareOverall(input, chart(serie('B', 'B', [100]))).series[0]!.data[0],
    ).toMatchObject({ count: 0, previous: undefined });
  });
});
