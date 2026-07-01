import { ReportChart } from '@/components/report-chart';
import { ReportInterval } from '@/components/report/ReportInterval';
import { ReportLineType } from '@/components/report/ReportLineType';
import { ReportSaveButton } from '@/components/report/ReportSaveButton';
import {
  changeDateRanges,
  changeEndDate,
  changeInterval,
  changeStartDate,
  ready,
  reset,
  setName,
  setReport,
} from '@/components/report/reportSlice';
import { ReportSidebar } from '@/components/report/sidebar/ReportSidebar';
import { TimeWindowPicker } from '@/components/time-window-picker';
import { Button } from '@/components/ui/button';
import { useAppParams } from '@/hooks/use-app-params';
import { useTRPC } from '@/integrations/trpc/react';
import { useDispatch, useSelector } from '@/redux';
import { cn } from '@/utils/cn';
import { bind } from 'bind-event-listener';
import {
  BellIcon,
  BellPlusIcon,
  ChevronRightIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { pushModal } from '@/modals';
import type { IServiceReport } from '@openpanel/db';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import EditReportName from '../report/edit-report-name';

interface ReportEditorProps {
  report: IServiceReport | null;
}

export default function ReportEditor({
  report: initialReport,
}: ReportEditorProps) {
  const { organizationId, projectId } = useAppParams();
  const { reportId } = useParams({ strict: false });
  const dashboardId = initialReport?.dashboardId;
  const search = useSearch({ strict: false });
  const rangeOverride = (search as { range?: string }).range;
  const dispatch = useDispatch();
  const report = useSelector((state) => state.report);
  const trpc = useTRPC();
  const [isPanelOpen, setIsPanelOpen] = useState(true);

  const { data: notificationRules } = useQuery({
    ...trpc.notification.rules.queryOptions({ projectId }),
    enabled: !!reportId,
  });

  const { data: dashboard } = useQuery({
    ...trpc.dashboard.byId.queryOptions({
      id: dashboardId ?? '',
      projectId,
    }),
    enabled: !!dashboardId,
  });

  const existingRule = useMemo(() => {
    if (!reportId || !notificationRules) return undefined;
    return notificationRules.find((rule) => {
      const config = rule.config as { type: string; reportId?: string };
      return (
        (config.type === 'threshold' || config.type === 'anomaly') &&
        config.reportId === reportId
      );
    });
  }, [reportId, notificationRules]);

  // Set report if reportId exists, applying URL range override in one shot
  useEffect(() => {
    if (initialReport) {
      dispatch(
        setReport(
          rangeOverride
            ? { ...initialReport, range: rangeOverride as any }
            : initialReport,
        ),
      );
    } else {
      dispatch(ready());
    }

    return () => {
      dispatch(reset());
    };
  }, [initialReport, dispatch, rangeOverride]);

  return (
    <div className="flex h-screen flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {dashboard && dashboardId && (
            <>
              <Link
                to="/$organizationId/$projectId/dashboards/$dashboardId"
                params={{ organizationId, projectId, dashboardId }}
                className="max-w-[45%] shrink-0 truncate text-lg font-medium text-muted-foreground transition-colors hover:text-foreground"
                title={dashboard.name}
              >
                {dashboard.name}
              </Link>
              <ChevronRightIcon
                size={18}
                className="shrink-0 text-muted-foreground"
              />
            </>
          )}
          <EditReportName />
        </div>
        <div className="row gap-2 whitespace-nowrap">
          {reportId &&
            (existingRule ? (
              <Button
                icon={BellIcon}
                variant="outline"
                size="sm"
                onClick={() => {
                  pushModal('AddNotificationRule', {
                    rule: existingRule,
                  });
                }}
              >
                Manage
              </Button>
            ) : (
              <Button
                icon={BellPlusIcon}
                variant="outline"
                size="sm"
                onClick={() => {
                  pushModal('AddNotificationRule', {
                    reportId,
                    projectId,
                  });
                }}
              >
                Add Alert
              </Button>
            ))}
          <ReportSaveButton />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            'flex shrink-0 flex-col border-r transition-[width]',
            isPanelOpen ? 'w-[330px]' : 'w-12',
          )}
        >
          {isPanelOpen && (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <ReportSidebar />
            </div>
          )}
          <div className="mt-auto shrink-0 px-4 pb-4 pt-2">
            <button
              type="button"
              onClick={() => setIsPanelOpen((open) => !open)}
              title={isPanelOpen ? 'Collapse' : 'Expand'}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-3 py-2 text-[13px] font-medium text-muted-foreground transition-all hover:bg-def-200',
                isPanelOpen ? 'justify-start' : 'justify-center',
              )}
            >
              {isPanelOpen ? (
                <PanelLeftCloseIcon size={18} className="shrink-0" />
              ) : (
                <PanelLeftOpenIcon size={18} className="shrink-0" />
              )}
              {isPanelOpen && <span>Collapse</span>}
            </button>
          </div>
        </aside>
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <TimeWindowPicker
              segmented
              onChange={(value) => {
                dispatch(changeDateRanges(value));
              }}
              value={report.range}
              onStartDateChange={(date) => dispatch(changeStartDate(date))}
              onEndDateChange={(date) => dispatch(changeEndDate(date))}
              endDate={report.endDate}
              startDate={report.startDate}
            />
            <div className="row ml-auto gap-2">
              <ReportInterval
                className="min-w-0"
                interval={report.interval}
                onChange={(newInterval) =>
                  dispatch(changeInterval(newInterval))
                }
                range={report.range}
                chartType={report.chartType}
                startDate={report.startDate}
                endDate={report.endDate}
              />
              <ReportLineType className="min-w-0" />
            </div>
          </div>
          <div className="flex flex-col gap-4 p-4" id="report-editor">
            {report.ready && (
              <ReportChart report={{ ...report, projectId }} isEditMode />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
