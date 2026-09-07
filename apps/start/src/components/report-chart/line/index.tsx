import { useTRPC } from '@/integrations/trpc/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { cn } from '@/utils/cn';
import { compareOverall } from '@openpanel/common';
import { useMemo } from 'react';
import { AspectContainer } from '../aspect-container';
import { ChartDownloadButton } from '../common/chart-download-button';
import { ReportChartEmpty } from '../common/empty';
import { ReportChartError } from '../common/error';
import { ReportChartLoading } from '../common/loading';
import { RefetchingOverlay } from '../common/refetching-overlay';
import { ReportChartProvider, useReportChartContext } from '../context';
import { Chart } from './chart';

export function ReportLineChart() {
  const context = useReportChartContext();
  const { isLazyLoading, report, options } = context;
  const comparing = report.comparison === 'overall';
  const trpc = useTRPC();

  const res = useQuery(
    trpc.chart.chart.queryOptions(report, {
      placeholderData: comparing ? undefined : keepPreviousData,
      enabled: !isLazyLoading,
    }),
  );

  const overall = useQuery(
    trpc.chart.chart.queryOptions(
      {
        ...report,
        breakdowns: [],
        offset: undefined,
        limit: Math.max(1, report.series.length),
      },
      { enabled: !isLazyLoading && comparing },
    ),
  );
  const displayData = useMemo(
    () =>
      res.data && comparing && overall.data
        ? compareOverall(res.data, overall.data)
        : res.data,
    [res.data, overall.data, comparing],
  );
  if (comparing && overall.isError) return <Error />;
  if (comparing && overall.isLoading) return <Loading />;

  if (
    isLazyLoading ||
    res.isLoading ||
    (res.isFetching && !res.data?.series.length)
  ) {
    return <Loading />;
  }

  if (res.isError) {
    return <Error />;
  }

  if (!res.data || res.data?.series.length === 0) {
    return <Empty />;
  }

  return (
    <div
      className={cn('relative group/chart', options?.fillHeight && 'h-full')}
    >
      <RefetchingOverlay
        isRefetching={res.isPlaceholderData && res.isFetching}
      />
      <ReportChartProvider
        {...context}
        report={{ ...report, unit: comparing ? '%' : report.unit }}
      >
        <AspectContainer>
          <Chart
            data={displayData!}
            absoluteData={comparing ? res.data : undefined}
            absoluteUnit={report.unit}
          />
        </AspectContainer>
        <ChartDownloadButton type="standard" data={res.data} />
      </ReportChartProvider>
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
