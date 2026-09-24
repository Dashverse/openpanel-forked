import { ReportChartType } from '@/components/report/ReportChartType';
import { changeChartType } from '@/components/report/reportSlice';
import { useDispatch, useSelector } from '@/redux';

import { ReportBreakdowns } from './ReportBreakdowns';
import { ReportGlobalFilters } from './ReportGlobalFilters';
import { ReportHoldProperties } from './ReportHoldProperties';
import { ReportSeries } from './ReportSeries';
import { ReportSettings } from './ReportSettings';

export function ReportSidebar() {
  const dispatch = useDispatch();
  const { chartType } = useSelector((state) => state.report);
  const showBreakdown = chartType !== 'retention';
  // Retention filters per-event (on each event's own "Add filter"), so the
  // report-level global filter section doesn't apply to it.
  const showGlobalFilters = chartType !== 'retention';
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="mb-2 font-medium">Chart type</h3>
        <ReportChartType
          className="w-full"
          value={chartType}
          onChange={(type) => dispatch(changeChartType(type))}
        />
      </div>
      <ReportSeries />
      {showGlobalFilters && <ReportGlobalFilters />}
      {(chartType === 'funnel' || chartType === 'conversion') && (
        <ReportHoldProperties />
      )}
      {showBreakdown && <ReportBreakdowns />}
      <ReportSettings />
    </div>
  );
}
