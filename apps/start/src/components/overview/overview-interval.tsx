import { useOverviewOptions } from '@/components/overview/useOverviewOptions';
import { ReportInterval } from '../report/ReportInterval';

export function OverviewInterval({ className }: { className?: string }) {
  const { interval, setInterval, range, startDate, endDate } =
    useOverviewOptions();

  return (
    <ReportInterval
      className={className}
      interval={interval}
      onChange={setInterval}
      range={range}
      chartType="linear"
      startDate={startDate}
      endDate={endDate}
    />
  );
}
