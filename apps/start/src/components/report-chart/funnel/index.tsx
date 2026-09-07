import { setHiddenSeries } from '@/components/report/reportSlice';
import { useTRPC } from '@/integrations/trpc/react';
import { useDispatch } from '@/redux';
import type { RouterOutputs } from '@/trpc/client';
import { useQuery } from '@tanstack/react-query';

import type { IChartInput } from '@openpanel/validation';

import { cn } from '@/utils/cn';
import { AspectContainer } from '../aspect-container';
import { ChartDownloadButton } from '../common/chart-download-button';
import { ReportChartEmpty } from '../common/empty';
import { ReportChartError } from '../common/error';
import { ReportChartLoading } from '../common/loading';
import { useReportChartContext } from '../context';
import { BreakdownTable, Chart, Summary, Tables } from './chart';
import { FunnelTtcChart } from './ttc-chart';

export function ReportFunnelChart() {
  const {
    report: {
      series,
      range,
      projectId,
      funnelWindow,
      funnelGroup,
      startDate,
      endDate,
      previous,
      breakdowns,
      holdProperties,
      globalFilters,
      measuring,
      cohortFilters,
      hiddenSeries = [],
    },
    isLazyLoading,
    isEditMode,
    options,
  } = useReportChartContext();

  const dispatch = useDispatch();
  const input: IChartInput = {
    series,
    range,
    projectId,
    interval: 'day',
    chartType: 'funnel',
    breakdowns,
    funnelWindow,
    funnelGroup,
    previous,
    metric: 'sum',
    startDate,
    endDate,
    limit: 20,
    holdProperties,
    globalFilters,
    measuring,
    cohortFilters,
  };
  const trpc = useTRPC();
  const res = useQuery(
    trpc.chart.funnel.queryOptions(input, {
      enabled: !isLazyLoading && input.series.length > 0,
    }),
  );

  if (isLazyLoading || res.isLoading) {
    return <Loading />;
  }

  if (res.isError) {
    return <Error />;
  }

  if (!res.data || res.data.current.length === 0) {
    return <Empty />;
  }

  const isTtc = measuring === 'time_to_convert';
  const visibleData = {
    ...res.data,
    current: res.data.current.filter((item) => !hiddenSeries.includes(item.id)),
  };
  const setHidden = (ids: string[]) => dispatch(setHiddenSeries(ids));

  return (
    <div
      className={cn(
        'col gap-4 relative group/chart',
        options?.fillHeight && 'h-full',
      )}
    >
      <ChartDownloadButton type="funnel" data={res.data} />
      {isEditMode && !isTtc && visibleData.current.length > 1 && (
        <Summary data={visibleData} />
      )}
      {visibleData.current.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          Select breakdown values to display.
        </div>
      ) : isTtc ? (
        <FunnelTtcChart
          data={visibleData as any}
          seriesOrder={res.data.current.map((item) => item.id)}
        />
      ) : (
        <Chart data={res.data} hiddenSeries={hiddenSeries} />
      )}
      {isEditMode &&
        (breakdowns.length > 0 ? (
          <BreakdownTable
            data={res.data}
            hiddenSeries={hiddenSeries}
            onHiddenSeriesChange={setHidden}
          />
        ) : (
          res.data.current.map((item) => (
            <Tables
              key={item.id}
              data={{
                current: item,
                previous:
                  res.data.previous?.find(
                    (previous) => previous.id === item.id,
                  ) ?? null,
              }}
            />
          ))
        ))}
    </div>
  );
}

function Loading() {
  return (
    <AspectContainer>
      <ReportChartLoading />
    </AspectContainer>
  );
}

function Error() {
  return (
    <AspectContainer>
      <ReportChartError />
    </AspectContainer>
  );
}

function Empty() {
  return (
    <AspectContainer>
      <ReportChartEmpty />
    </AspectContainer>
  );
}
