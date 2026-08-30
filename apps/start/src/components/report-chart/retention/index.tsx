import { useTRPC } from '@/integrations/trpc/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { AspectContainer } from '../aspect-container';
import { ChartDownloadButton } from '../common/chart-download-button';
import { ReportChartEmpty } from '../common/empty';
import { ReportChartError } from '../common/error';
import { ReportChartLoading } from '../common/loading';
import { RefetchingOverlay } from '../common/refetching-overlay';
import { useReportChartContext } from '../context';
import { Chart } from './chart';
import CohortTable from './table';

export function ReportRetentionChart() {
  const {
    report: {
      series,
      range,
      projectId,
      startDate,
      endDate,
      criteria,
      interval,
      globalFilters,
    },
    isLazyLoading,
  } = useReportChartContext();
  const eventSeries = series.filter((item) => item.type === 'event');
  const firstEvent = (eventSeries[0]?.filters?.[0]?.value ?? []).map(String);
  const secondEvent = (eventSeries[1]?.filters?.[0]?.value ?? []).map(String);
  // The retention "Filter" section writes to report.globalFilters. Pass those to
  // the cohort procedure so property-filtered retention fires (the server keeps
  // only property filters and routes them to the v2 property MV / events; cohort
  // filters are ignored server-side for now). Skip filters that don't have a
  // value yet — a half-configured filter (property picked, value still empty)
  // would otherwise send `IN ()` and blank the chart before you choose a value.
  const filters = (globalFilters ?? []).filter(
    (f) => Array.isArray(f.value) && f.value.length > 0,
  );
  const isEnabled =
    firstEvent.length > 0 && secondEvent.length > 0 && !isLazyLoading;
  const trpc = useTRPC();
  const res = useQuery(
    trpc.chart.cohort.queryOptions(
      {
        firstEvent,
        secondEvent,
        projectId,
        range,
        startDate,
        endDate,
        criteria,
        interval,
        filters,
      },
      {
        placeholderData: keepPreviousData,
        enabled: isEnabled,
      },
    ),
  );

  if (!isEnabled) {
    return <Disabled />;
  }

  if (isLazyLoading || res.isLoading) {
    return <Loading />;
  }

  if (res.isError) {
    return <Error />;
  }

  if (!res.data || res.data?.length === 0) {
    return <Empty />;
  }

  return (
    <div className="col gap-4 relative group/chart">
      <RefetchingOverlay isRefetching={res.isPlaceholderData && res.isFetching} />
      <ChartDownloadButton type="cohort" data={res.data} />
      <AspectContainer>
        <Chart data={res.data} />
      </AspectContainer>
      <CohortTable data={res.data} />
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

function Disabled() {
  return (
    <AspectContainer>
      <ReportChartEmpty title="Select 2 events">
        We need two events to determine the retention rate.
      </ReportChartEmpty>
    </AspectContainer>
  );
}
