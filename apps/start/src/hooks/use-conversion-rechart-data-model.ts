import type { RouterOutputs } from '@/trpc/client';
import { useMemo } from 'react';

export function useConversionRechartDataModel(
  series: RouterOutputs['chart']['conversion']['current'],
) {
  return useMemo(() => {
    if (!series.length || !series[0]?.data.length) {
      return [];
    }

    // X-axis dates = the UNION of dates across ALL series, sorted.
    // The old code used only `series[0].data` on the assumption that "all series
    // share the same dates" — but breakdown conversion series do NOT: a breakdown
    // value only has points on days it had a cohort. If series[0] happened to be a
    // sparse value (e.g. one that only converted on a day or two), the whole x-axis
    // truncated to those days, silently dropping recent days that OTHER series had.
    const dates = Array.from(
      new Set(series.flatMap((serie) => serie.data.map((item) => item.date))),
    ).sort();

    return dates.map((date) => {
      // Build the point from EVERY series' value for this date (each may or may not
      // have data on a given day). No early-return keyed on series[0] — that would
      // drop a date present only in later series.
      const dataPoint: Record<string, any> = {
        date,
        timestamp: new Date(date).getTime(),
      };

      series.forEach((serie) => {
        const item = serie.data.find((d) => d.date === date);
        if (item) {
          dataPoint[`${serie.id}:rate`] = item.rate;
          dataPoint[`${serie.id}:previousRate`] = item.previousRate;
          dataPoint[`${serie.id}:total`] = item.total;
          dataPoint[`${serie.id}:conversions`] = item.conversions;
          if (item.ttc) {
            dataPoint[`${serie.id}:ttc`] = item.ttc;
          }
        }
      });

      return dataPoint;
    });
  }, [series]);
}

