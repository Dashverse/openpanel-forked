import type { FinalChart, IChartSerie, Metrics } from '@openpanel/validation';
import { getPreviousMetric } from './get-previous-metric';

const ratio = (value: number, total: number | undefined) =>
  total && Number.isFinite(total) ? value / total : 0;

export function compareOverall(
  chart: FinalChart,
  overall: FinalChart,
): FinalChart {
  const totals = new Map(
    overall.series.map((serie) => [serie.event.id ?? serie.event.name, serie]),
  );
  const series = chart.series.map((serie): IChartSerie => {
    const total = totals.get(serie.event.id ?? serie.event.name);
    const dates = new Map(total?.data.map((point) => [point.date, point]));
    const data = serie.data.map((point) => {
      const denominator = dates.get(point.date);
      const count = ratio(point.count, denominator?.count);
      return {
        ...point,
        count,
        previous:
          point.previous && denominator?.previous
            ? getPreviousMetric(
                count,
                ratio(point.previous.value, denominator.previous.value),
              )
            : undefined,
      };
    });
    const metricsFor = (previous: boolean): Metrics => {
      const values = data.map((point) =>
        previous ? (point.previous?.value ?? 0) : point.count,
      );
      const sum = previous
        ? (serie.metrics.previous?.sum?.value ?? 0)
        : serie.metrics.sum;
      const totalSum = previous
        ? total?.metrics.previous?.sum?.value
        : total?.metrics.sum;
      const count = previous
        ? serie.metrics.previous?.count?.value
        : serie.metrics.count;
      return {
        sum: ratio(sum, totalSum),
        average: values.length
          ? values.reduce((a, b) => a + b, 0) / values.length
          : 0,
        min: values.length ? Math.min(...values) : 0,
        max: values.length ? Math.max(...values) : 0,
        count,
      };
    };
    const metrics = metricsFor(false);
    if (data.some((point) => point.previous)) {
      const previous = metricsFor(true);
      metrics.previous = {
        sum: getPreviousMetric(metrics.sum, previous.sum),
        average: getPreviousMetric(metrics.average, previous.average),
        min: getPreviousMetric(metrics.min, previous.min),
        max: getPreviousMetric(metrics.max, previous.max),
        count: serie.metrics.previous?.count,
      };
    }
    return { ...serie, data, metrics };
  });
  return { ...chart, series };
}
