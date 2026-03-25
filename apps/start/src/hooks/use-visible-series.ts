import { setHiddenSeries } from '@/components/report/reportSlice';
import { useReportChartContext } from '@/components/report-chart/context';
import { useDispatch } from '@/redux';
import type { IChartData } from '@/trpc/client';
import { useCallback, useEffect, useMemo, useState } from 'react';

export type IVisibleSeries = ReturnType<typeof useVisibleSeries>['series'];
export function useVisibleSeries(data: IChartData, limit?: number | undefined) {
  const max = limit ?? 5;
  const dispatch = useDispatch();
  const { isEditMode, report } = useReportChartContext();
  const persistedHiddenSeries = (report.hiddenSeries ?? []) as string[];

  const [visibleSeries, setVisibleSeriesState] = useState<string[]>(() => {
    const allIds = data?.series?.slice(0, max).map((serie) => serie.id) ?? [];
    return allIds.filter((id) => !persistedHiddenSeries.includes(id));
  });

  // Issue 2 fix: include persistedHiddenSeries in deps so it re-runs on report load
  useEffect(() => {
    const allIds = data?.series?.slice(0, max).map((serie) => serie.id) ?? [];
    setVisibleSeriesState(
      allIds.filter((id) => !persistedHiddenSeries.includes(id)),
    );
  }, [data, max, persistedHiddenSeries]);

  // Issue 3 fix: memoize with useCallback to avoid recreating on every render
  // Issue 1 fix: only dispatch to Redux when in edit mode (report editor page)
  const setVisibleSeries = useCallback(
    (ids: string[]) => {
      setVisibleSeriesState(ids);
      if (isEditMode) {
        const allIds = data?.series?.map((serie) => serie.id) ?? [];
        const hidden = allIds.filter((id) => !ids.includes(id));
        dispatch(setHiddenSeries(hidden));
      }
    },
    [data, isEditMode, dispatch],
  );

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
  }, [visibleSeries, data.series, setVisibleSeries]);
}
