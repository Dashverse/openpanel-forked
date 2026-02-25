import type { IChartData } from '@/trpc/client';
import { useCallback, useEffect, useMemo, useState } from 'react';

type VisibleSeriesOptions = {
  initialSeries?: string[];
  onChange?: (ids: string[]) => void;
};

export type IVisibleSeries = ReturnType<typeof useVisibleSeries>['series'];
export function useVisibleSeries(
  data: IChartData,
  limit?: number | undefined,
  options?: VisibleSeriesOptions,
) {
  const max = limit ?? 5;
  const { initialSeries, onChange } = options ?? {};

  const getDefaultIds = useCallback(() => {
    if (initialSeries !== undefined) {
      const validIds = initialSeries.filter((id) =>
        data?.series?.some((s) => s.id === id),
      );
      return validIds.length > 0
        ? validIds
        : data?.series?.slice(0, max).map((s) => s.id) ?? [];
    }
    return data?.series?.slice(0, max).map((serie) => serie.id) ?? [];
  // initialSeries is stable (comes from saved report config)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, max]);

  const [visibleSeries, setVisibleSeries] = useState<string[]>(getDefaultIds);

  useEffect(() => {
    setVisibleSeries(getDefaultIds());
  }, [getDefaultIds]);

  const handleSetVisibleSeries: typeof setVisibleSeries = useCallback(
    (value) => {
      setVisibleSeries((prev) => {
        const next = typeof value === 'function' ? value(prev) : value;
        onChange?.(next);
        return next;
      });
    },
    // onChange is stable (dispatch function from Redux)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return useMemo(() => {
    return {
      series: data.series
        .map((serie, index) => ({
          ...serie,
          index,
        }))
        .filter((serie) => visibleSeries.includes(serie.id)),
      setVisibleSeries: handleSetVisibleSeries,
    } as const;
  }, [visibleSeries, data.series, handleSetVisibleSeries]);
}
