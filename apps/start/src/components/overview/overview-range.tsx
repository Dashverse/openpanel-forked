import { useOverviewOptions } from '@/components/overview/useOverviewOptions';
import { TimeWindowPicker } from '@/components/time-window-picker';

export function OverviewRange({ className }: { className?: string }) {
  const { range, setRange, setStartDate, setEndDate, endDate, startDate } =
    useOverviewOptions();

  return (
    <TimeWindowPicker
      segmented
      className={className}
      onChange={setRange}
      value={range}
      onStartDateChange={setStartDate}
      onEndDateChange={setEndDate}
      endDate={endDate}
      startDate={startDate}
    />
  );
}
