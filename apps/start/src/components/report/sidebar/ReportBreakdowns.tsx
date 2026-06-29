import { ColorSquare } from '@/components/color-square';
import { Combobox } from '@/components/ui/combobox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAppParams } from '@/hooks/use-app-params';
import { useEventProperties } from '@/hooks/use-event-properties';
import { useCohorts } from '@/hooks/use-cohorts';
import { useDispatch, useSelector } from '@/redux';
import { ChevronsUpDownIcon, SplitIcon, UsersIcon } from 'lucide-react';

import type { IChartBreakdown } from '@openpanel/validation';

import { Button } from '@/components/ui/button';
import { InputEnter } from '@/components/ui/input-enter';
import { addBreakdown, changeBreakdown, changeLimit, removeBreakdown } from '../reportSlice';
import { PropertiesCombobox } from './PropertiesCombobox';
import { ReportBreakdownMore } from './ReportBreakdownMore';
import type { ReportEventMoreProps } from './ReportEventMore';

// Label for the funnel breakdown source-step selector.
function stepLabel(step: IChartBreakdown['step']): string {
  if (step === 'first') return 'First step defined';
  if (step === 'last') return 'Last step defined';
  if (typeof step === 'number') return `Step ${step}`;
  return 'Step 1';
}

export function ReportBreakdowns() {
  const { projectId } = useAppParams();
  const selectedBreakdowns = useSelector((state) => state.report.breakdowns);
  const limit = useSelector((state) => state.report.limit);
  const chartType = useSelector((state) => state.report.chartType);
  const series = useSelector((state) => state.report.series);
  const { items: cohorts } = useCohorts({ projectId, includeCount: false });
  const dispatch = useDispatch();

  // Funnel steps = the event series. The breakdown value can be sourced from a
  // chosen step (Mixpanel "breakdown on step N"); only meaningful for funnels.
  const stepCount = series.filter(
    (s) => !('type' in s) || s.type === 'event',
  ).length;
  const stepOptions: IChartBreakdown['step'][] = [
    'first',
    'last',
    ...Array.from({ length: stepCount }, (_, i) => i + 1),
  ];

  const handleMore = (breakdown: IChartBreakdown) => {
    const callback: ReportEventMoreProps['onClick'] = (action) => {
      switch (action) {
        case 'remove': {
          return dispatch(removeBreakdown(breakdown));
        }
      }
    };

    return callback;
  };

  return (
    <div>
      <h3 className="mb-2 font-medium">Breakdown</h3>
      <div className="flex flex-col gap-4">
        {selectedBreakdowns.map((item, index) => {
          // Match the backend's cohort check (prefix OR cohortId) so the step
          // selector is hidden for any cohort-backed breakdown.
          const isCohortBreakdown =
            item.name.startsWith('cohort:') || !!item.cohortId;
          const cohortId = isCohortBreakdown
            ? (item.cohortId || item.name.split(':')[1])
            : null;
          const cohort = cohortId ? cohorts.find(c => c.id === cohortId) : null;
          const displayName = cohort ? cohort.name : item.name;

          return (
            <div key={item.id || item.name} className="rounded-lg border bg-def-100">
              <div className="flex items-center gap-2 p-2 px-4">
                <ColorSquare>{index}</ColorSquare>
                <PropertiesCombobox
                  onSelect={(action) => {
                    dispatch(
                      changeBreakdown({
                        ...item,
                        name: action.value,
                        cohortId: action.cohortId,
                      }),
                    );
                  }}
                >
                  {(setOpen) => (
                    <Button
                      variant={'outline'}
                      onClick={() => setOpen((prev) => !prev)}
                      size={'sm'}
                      autoHeight
                      className="flex-1"
                    >
                      <div className="row w-full gap-2 items-center">
                        {isCohortBreakdown
                          ? <UsersIcon className="size-4" />
                          : <SplitIcon className="size-4" />
                        }
                        {displayName}
                      </div>
                      <ChevronsUpDownIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  )}
                </PropertiesCombobox>
                <ReportBreakdownMore onClick={handleMore(item)} />
              </div>

              {/* Funnel-only: which step's event the breakdown value comes from.
                  Lets you break down by a property that only exists on a later
                  step (e.g. showId on step 2). */}
              {chartType === 'funnel' && !isCohortBreakdown && (
                <div className="px-4 pb-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground"
                      >
                        Breakdown on {stepLabel(item.step)}
                        <ChevronsUpDownIcon className="ml-2 h-3 w-3 shrink-0 opacity-50" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {stepOptions.map((step) => (
                        <DropdownMenuItem
                          key={String(step)}
                          onClick={() =>
                            dispatch(changeBreakdown({ ...item, step }))
                          }
                        >
                          {stepLabel(step)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>
          );
        })}

        {selectedBreakdowns.length > 0 && (
          <div className="flex items-center justify-between gap-4">
            <span className="whitespace-nowrap font-medium text-sm">Limit</span>
            <InputEnter
              type="number"
              value={String(limit)}
              placeholder="Default: 50"
              onChangeValue={(value) => {
                const parsed = Number.parseInt(value, 10);
                if (!Number.isNaN(parsed) && parsed > 0) {
                  dispatch(changeLimit(parsed));
                }
              }}
            />
          </div>
        )}

        <PropertiesCombobox
          onSelect={(action) => {
            dispatch(
              addBreakdown({
                name: action.value,
                cohortId: action.cohortId,
              }),
            );
          }}
        >
          {(setOpen) => (
            <Button
              variant={'outline'}
              onClick={() => setOpen((prev) => !prev)}
              size={'sm'}
              autoHeight
              className="flex-1"
            >
              <div className="row w-full gap-2 items-center">
                <SplitIcon className="size-4" />
                Select breakdown
              </div>
              <ChevronsUpDownIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          )}
        </PropertiesCombobox>
      </div>
    </div>
  );
}
