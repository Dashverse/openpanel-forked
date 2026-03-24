import { setHiddenSeries } from '@/components/report/reportSlice';
import { useDispatch, useSelector } from '@/redux';
import type { IChartData } from '@/trpc/client';
import { useEffect, useMemo, useState } from 'react';

export type IVisibleSeries = ReturnType<typeof useVisibleSeries>['series'];
export function useVisibleSeries(data: IChartData, limit?: number | undefined) {
  const max = limit ?? 5;
  const dispatch = useDispatch();
  const persistedHiddenSeries = useSelector(
    (state) => state.report.hiddenSeries ?? [],
  );

  const [visibleSeries, setVisibleSeriesState] = useState<string[]>(() => {
    const allIds = data?.series?.slice(0, max).map((serie) => serie.id) ?? [];
    return allIds.filter((id) => !persistedHiddenSeries.includes(id));
  });

  useEffect(() => {
    const allIds = data?.series?.slice(0, max).map((serie) => serie.id) ?? [];
    setVisibleSeriesState(
      allIds.filter((id) => !persistedHiddenSeries.includes(id)),
    );
  }, [data, max]);

  const setVisibleSeries = (ids: string[]) => {
    setVisibleSeriesState(ids);
    const allIds = data?.series?.map((serie) => serie.id) ?? [];
    const hidden = allIds.filter((id) => !ids.includes(id));
    dispatch(setHiddenSeries(hidden));
  };

  return useMemo(() => {
    return {
      series: data.series
        .map((serie, index) => ({
          ...serie,
          index,
        }))
        .filter((serie) => visibleSeries.includes(serie.id)),
      setVisibleSeries,
    } as const;
  }, [visibleSeries, data.series]);
}
