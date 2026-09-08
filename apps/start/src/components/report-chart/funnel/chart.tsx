import { ColorSquare } from '@/components/color-square';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { pushModal } from '@/modals';
import type { RouterOutputs } from '@/trpc/client';
import { cn } from '@/utils/cn';
import { ChevronRightIcon, InfoIcon, UsersIcon } from 'lucide-react';

import { alphabetIds } from '@openpanel/constants';

import { createChartTooltip } from '@/components/charts/chart-tooltip';
import { BarShapeBlue, BarShapeProps } from '@/components/charts/common-bar';
import { Tooltiper } from '@/components/ui/tooltip';
import { WidgetTable } from '@/components/widget-table';
import { useNumber } from '@/hooks/use-numer-formatter';
import { getChartColor, getChartTranslucentColor } from '@/utils/theme';
import { getPreviousMetric } from '@openpanel/common';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { useXAxisProps, useYAxisProps } from '../common/axis';
import { PreviousDiffIndicatorPure } from '../common/previous-diff-indicator';
import { useReportChartContext } from '../context';

type Props = {
  data: {
    current: RouterOutputs['chart']['funnel']['current'][number];
    previous: RouterOutputs['chart']['funnel']['current'][number] | null;
  };
};

// Conversion % label shown on top of each funnel bar.
// Integer labels for readability, but show one decimal for small non-zero
// values (0 < n < 1) so a real 0.2% isn't rounded down to a misleading "0%"
// (the table shows 0.2%, so the graph must not disagree).
const formatPercentLabel = (value: number | string | undefined) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n > 0 && n < 1 ? `${Math.round(n * 100) / 100}%` : `${Math.round(n)}%`;
};

export const Metric = ({
  label,
  value,
  enhancer,
  className,
}: {
  label: string;
  value: React.ReactNode;
  enhancer?: React.ReactNode;
  className?: string;
}) => (
  <div className={cn('gap-1 justify-between flex-1 col', className)}>
    <div className="text-sm text-muted-foreground">{label}</div>
    <div className="row items-center gap-2 justify-between">
      <div className="font-mono font-semibold">{value}</div>
      {enhancer && <div>{enhancer}</div>}
    </div>
  </div>
);

export function Summary({ data }: { data: RouterOutputs['chart']['funnel'] }) {
  const number = useNumber();
  const highestConversion = data.current
    .slice(0)
    .sort((a, b) => b.lastStep.percent - a.lastStep.percent)[0];
  const highestCount = data.current
    .slice(0)
    .sort((a, b) => b.lastStep.count - a.lastStep.count)[0];
  return (
    <div className="grid grid-cols-2 gap-4">
      {highestConversion && (
        <div className="card row items-center p-4 py-3">
          <Metric
            label="Highest conversion rate"
            value={
              <ChartName breakdowns={highestConversion.breakdowns ?? []} />
            }
          />
          <span className="text-xl font-semibold font-mono">
            {number.formatWithUnit(
              highestConversion.lastStep.percent / 100,
              '%',
            )}
          </span>
        </div>
      )}
      {highestCount && (
        <div className="card row items-center p-4 py-3">
          <Metric
            label="Most conversions"
            value={<ChartName breakdowns={highestCount.breakdowns ?? []} />}
          />
          <span className="text-xl font-semibold font-mono">
            {number.format(highestCount.lastStep.count)}
          </span>
        </div>
      )}
    </div>
  );
}

function ChartName({
  breakdowns,
  className,
}: { breakdowns: string[]; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2 font-medium', className)}>
      {breakdowns.map((name, index) => {
        return (
          <>
            {index !== 0 && <ChevronRightIcon className="size-3" />}
            <span key={name}>{name}</span>
          </>
        );
      })}
    </div>
  );
}

function useInspectFunnelStep() {
  const {
    report: {
      projectId,
      startDate,
      endDate,
      range,
      interval,
      series: reportSeries,
      breakdowns: reportBreakdowns,
      previous,
      funnelWindow,
      funnelGroup,
    },
  } = useReportChartContext();

  return (
    step: Props['data']['current']['steps'][number],
    stepIndex: number,
  ) => {
    if (!projectId || !step.event.id) return;

    // For funnels, we need to pass the step index so the modal can query
    // users who completed at least that step in the funnel sequence
    pushModal('ViewChartUsers', {
      type: 'funnel',
      report: {
        projectId,
        series: reportSeries,
        breakdowns: reportBreakdowns || [],
        interval: interval || 'day',
        startDate,
        endDate,
        range,
        previous,
        chartType: 'funnel',
        metric: 'sum',
        funnelWindow,
        funnelGroup,
      },
      stepIndex, // Pass the step index for funnel queries
    });
  };
}

export function Tables({
  data: {
    current: { steps, mostDropoffsStep, lastStep, breakdowns },
    previous: previousData,
  },
}: Props) {
  const number = useNumber();
  const hasHeader = breakdowns.length > 0;
  const handleInspectStep = useInspectFunnelStep();
  return (
    <div className={cn('col @container divide-y divide-border card')}>
      {hasHeader && <ChartName breakdowns={breakdowns} className="p-4 py-3" />}
      <div className={cn('bg-def-100', !hasHeader && 'rounded-t-md')}>
        <div className="col max-md:divide-y md:row md:items-center md:divide-x divide-border">
          <Metric
            className="p-4 py-3"
            label="Conversion"
            value={number.formatWithUnit(lastStep?.percent / 100, '%')}
            enhancer={
              previousData && (
                <PreviousDiffIndicatorPure
                  {...getPreviousMetric(
                    lastStep?.percent,
                    previousData.lastStep?.percent,
                  )}
                />
              )
            }
          />
          <Metric
            className="p-4 py-3"
            label="Completed"
            value={number.format(lastStep?.count)}
            enhancer={
              previousData && (
                <PreviousDiffIndicatorPure
                  {...getPreviousMetric(
                    lastStep?.count,
                    previousData.lastStep?.count,
                  )}
                />
              )
            }
          />
          {!!mostDropoffsStep && (
            <Metric
              className="p-4 py-3"
              label="Most dropoffs after"
              value={mostDropoffsStep?.event?.displayName}
              enhancer={
                <Tooltiper
                  tooltipClassName="max-w-xs"
                  content={
                    <span>
                      <span className="font-semibold">
                        {mostDropoffsStep?.dropoffCount}
                      </span>{' '}
                      dropped after this event. Improve this step and your
                      conversion rate will likely increase.
                    </span>
                  }
                >
                  <InfoIcon className="size-3" />
                </Tooltiper>
              }
            />
          )}
        </div>
      </div>
      <div className="col divide-y divide-def-200">
        <WidgetTable
          data={steps}
          keyExtractor={(item) => item.event.id!}
          className={'text-sm @container'}
          columnClassName="px-2 group/row items-center"
          eachRow={(item, index) => {
            return (
              <div className="absolute inset-px !p-0">
                <div
                  className={cn(
                    'h-full bg-def-300 group-hover/row:bg-blue-200 dark:group-hover/row:bg-blue-900 transition-colors relative',
                    item.isHighestDropoff && [
                      'bg-red-500/20',
                      'group-hover/row:bg-red-500/70',
                    ],
                    index === steps.length - 1 && 'rounded-bl-sm',
                  )}
                  style={{
                    width: `${item.percent}%`,
                  }}
                />
              </div>
            );
          }}
          columns={[
            {
              name: 'Event',
              render: (item, index) => (
                <div className="row items-center gap-2 min-w-0 relative">
                  <ColorSquare color={getChartColor(index)}>
                    {alphabetIds[index]}
                  </ColorSquare>
                  <span className="truncate">{item.event.displayName}</span>
                </div>
              ),
              width: 'w-full',
              className: 'text-left font-mono font-semibold',
            },
            {
              name: 'Completed',
              render: (item) => number.format(item.count),
              className: 'text-right font-mono hidden @xl:block',
              width: '82px',
            },
            {
              name: 'Dropped after',
              render: (item) =>
                item.dropoffCount !== null && item.dropoffPercent !== null
                  ? number.format(item.dropoffCount)
                  : null,
              className: 'text-right font-mono hidden @xl:block',
              width: '110px',
            },
            {
              name: 'Conversion',
              render: (item) => number.formatWithUnit(item.percent / 100, '%'),
              className: 'text-right font-mono font-semibold',
              width: '90px',
            },
            {
              name: '',
              render: (item) => (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    const stepIndex = steps.findIndex(
                      (s) => s.event.id === item.event.id,
                    );
                    handleInspectStep(item, stepIndex);
                  }}
                  title="View users who completed this step"
                >
                  <UsersIcon size={16} />
                </Button>
              ),
              className: 'text-right',
              width: '48px',
            },
          ]}
        />
      </div>
    </div>
  );
}

export function BreakdownTable({
  data,
  hiddenSeries,
  onHiddenSeriesChange,
}: {
  data: RouterOutputs['chart']['funnel'];
  hiddenSeries: string[];
  onHiddenSeriesChange: (ids: string[]) => void;
}) {
  const number = useNumber();
  const handleInspectStep = useInspectFunnelStep();
  const steps = data.current[0]?.steps ?? [];

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table aria-label="Funnel breakdown">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead
              scope="col"
              className="sticky left-0 z-10 min-w-48 bg-card border-r"
            >
              <div className="flex items-center gap-2">
                <Checkbox
                  aria-label="Select all breakdowns"
                  checked={
                    data.current.every(
                      (item) => !hiddenSeries.includes(item.id),
                    )
                      ? true
                      : data.current.some(
                            (item) => !hiddenSeries.includes(item.id),
                          )
                        ? 'indeterminate'
                        : false
                  }
                  onCheckedChange={(checked) =>
                    onHiddenSeriesChange(
                      checked ? [] : data.current.map((item) => item.id),
                    )
                  }
                />
                Breakdown
              </div>
            </TableHead>
            {steps.map((step, index) => (
              <TableHead
                key={step.event.id}
                scope="col"
                className="min-w-44 border-r last:border-r-0 normal-case text-sm"
              >
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{index + 1}.</span>
                  {step.event.displayName}
                </div>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.current.map((funnel, breakdownIndex) => {
            const previous = data.previous?.find(
              (item) => item.id === funnel.id,
            );
            return (
              <TableRow key={funnel.id}>
                <TableHead
                  scope="row"
                  className="sticky left-0 z-10 bg-card border-r normal-case text-sm"
                >
                  <div className="flex items-center gap-2">
                    <Checkbox
                      aria-label={`Show ${funnel.breakdowns.join(' / ') || 'breakdown'}`}
                      checked={!hiddenSeries.includes(funnel.id)}
                      onCheckedChange={(checked) =>
                        onHiddenSeriesChange(
                          checked
                            ? hiddenSeries.filter((id) => id !== funnel.id)
                            : [...hiddenSeries, funnel.id],
                        )
                      }
                    />
                    <ColorSquare color={getChartColor(breakdownIndex)} />
                    <ChartName breakdowns={funnel.breakdowns} />
                  </div>
                </TableHead>
                {steps.map((column, stepIndex) => {
                  const step = funnel.steps.find(
                    (item) => item.event.id === column.event.id,
                  );
                  const previousStep = previous?.steps.find(
                    (item) => item.event.id === column.event.id,
                  );
                  return (
                    <TableCell
                      key={column.event.id}
                      className="border-r last:border-r-0 py-2"
                    >
                      {step ? (
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex items-baseline gap-2 tabular-nums">
                            <div className="font-mono font-semibold">
                              {number.format(step.count)}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span title="Conversion from the first step">
                                {number.formatWithUnit(step.percent / 100, '%')}
                              </span>
                              {previousStep && (
                                <PreviousDiffIndicatorPure
                                  {...getPreviousMetric(
                                    step.percent,
                                    previousStep.percent,
                                  )}
                                />
                              )}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 shrink-0 p-0"
                            onClick={() => handleInspectStep(step, stepIndex)}
                            aria-label={`View users who completed ${step.event.displayName}`}
                            title="View users who completed this step"
                          >
                            <UsersIcon size={16} />
                          </Button>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

type RechartData = {
  name: string;
  [key: `step:percent:${number}`]: number | null;
  [key: `step:data:${number}`]:
    | (RouterOutputs['chart']['funnel']['current'][number] & {
        step: RouterOutputs['chart']['funnel']['current'][number]['steps'][number];
      })
    | null;
  [key: `prev_step:percent:${number}`]: number | null;
  [key: `prev_step:data:${number}`]:
    | (RouterOutputs['chart']['funnel']['current'][number] & {
        step: RouterOutputs['chart']['funnel']['current'][number]['steps'][number];
      })
    | null;
};

const useRechartData = ({
  current,
  previous,
}: RouterOutputs['chart']['funnel']): RechartData[] => {
  const firstFunnel = current[0];
  return (
    firstFunnel?.steps.map((step, stepIndex) => {
      return {
        id: step?.event.id ?? '',
        name: step?.event.displayName ?? '',
        ...current.reduce((acc, item, index) => {
          const diff = previous?.find((previous) => previous.id === item.id);
          return {
            ...acc,
            [`step:percent:${index}`]: item.steps[stepIndex]?.percent ?? null,
            [`step:data:${index}`]: {
              ...item,
              step: item.steps[stepIndex],
            },
            [`prev_step:percent:${index}`]:
              diff?.steps[stepIndex]?.percent ?? null,
            [`prev_step:data:${index}`]: diff
              ? {
                  ...diff,
                  step: diff?.steps?.[stepIndex],
                }
              : null,
          };
        }, {}),
      };
    }) ?? []
  );
};

export function Chart({
  data,
  hiddenSeries = [],
}: { data: RouterOutputs['chart']['funnel']; hiddenSeries?: string[] }) {
  const rechartData = useRechartData(data);
  const xAxisProps = useXAxisProps();
  const yAxisProps = useYAxisProps();
  const hasBreakdowns = data.current.length > 1;
  const { options, isEditMode } = useReportChartContext();

  return (
    <TooltipProvider data={data.current} hiddenSeries={hiddenSeries}>
      <div
        className={cn(
          'w-full',
          options?.fillHeight
            ? 'h-full'
            : 'aspect-video max-h-[250px] p-4 pb-1',
          isEditMode && 'card',
        )}
      >
        <ResponsiveContainer>
          <BarChart
            data={rechartData}
            margin={{ top: 20, right: 5, left: 5, bottom: 5 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              horizontal={true}
              vertical={true}
              className="stroke-border"
            />
            <XAxis
              {...xAxisProps}
              dataKey="id"
              allowDuplicatedCategory={false}
              type={'category'}
              scale="auto"
              domain={undefined}
              interval="preserveStartEnd"
              tickSize={0}
              tickMargin={4}
              tickFormatter={(id) =>
                data.current[0].steps.find((step) => step.event.id === id)
                  ?.event.displayName ?? ''
              }
            />
            <YAxis {...yAxisProps} />
            {hasBreakdowns ? (
              data.current.map(
                (item, breakdownIndex) =>
                  !hiddenSeries.includes(item.id) && (
                    <Bar
                      key={`step:percent:${item.id}`}
                      dataKey={`step:percent:${breakdownIndex}`}
                      shape={<BarShapeProps />}
                    >
                      {rechartData.map((item, stepIndex) => (
                        <Cell
                          key={`${item.name}-${breakdownIndex}`}
                          fill={getChartTranslucentColor(breakdownIndex)}
                          stroke={getChartColor(breakdownIndex)}
                        />
                      ))}
                      <LabelList
                        dataKey={`step:percent:${breakdownIndex}`}
                        position="top"
                        offset={8}
                        className="fill-foreground"
                        fontSize={10}
                        formatter={formatPercentLabel}
                      />
                    </Bar>
                  ),
              )
            ) : (
              <Bar
                data={rechartData}
                dataKey="step:percent:0"
                shape={<BarShapeProps />}
              >
                {rechartData.map((item, index) => (
                  <Cell
                    key={item.name}
                    fill={getChartTranslucentColor(index)}
                    stroke={getChartColor(index)}
                  />
                ))}
                <LabelList
                  dataKey="step:percent:0"
                  position="top"
                  offset={8}
                  className="fill-foreground"
                  fontSize={10}
                  formatter={formatPercentLabel}
                />
              </Bar>
            )}
            <Tooltip />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </TooltipProvider>
  );
}

const { Tooltip, TooltipProvider } = createChartTooltip<
  RechartData,
  {
    data: RouterOutputs['chart']['funnel']['current'];
    hiddenSeries: string[];
  }
>(({ data: dataArray, context, ...props }) => {
  const data = dataArray[0]!;
  const number = useNumber();
  const variants = Object.keys(data).filter((key) =>
    key.startsWith('step:data:'),
  ) as `step:data:${number}`[];

  const index = context.data[0].steps.findIndex(
    (step) => step.event.id === (data as any).id,
  );

  return (
    <>
      <div className="flex justify-between gap-8 text-muted-foreground">
        <div>{data.name}</div>
      </div>
      {variants.map((key, breakdownIndex) => {
        const variant = data[key];
        const prevVariant = data[`prev_${key}`];
        if (!variant?.step || context.hiddenSeries.includes(variant.id)) {
          return null;
        }
        return (
          <div className="row gap-2" key={key}>
            <div
              className="w-[3px] rounded-full"
              style={{
                background: getChartColor(
                  variants.length > 1 ? breakdownIndex : index,
                ),
              }}
            />
            <div className="col flex-1 gap-1">
              <div className="flex items-center gap-1">
                <ChartName breakdowns={variant.breakdowns ?? []} />
              </div>
              <div className="flex justify-between gap-8 font-mono font-medium">
                <div className="col gap-1">
                  <span>
                    {number.formatWithUnit(variant.step.percent / 100, '%')}
                  </span>
                  <span className="text-muted-foreground">
                    ({number.format(variant.step.count)})
                  </span>
                </div>

                <PreviousDiffIndicatorPure
                  {...getPreviousMetric(
                    variant.step.percent,
                    prevVariant?.step.percent,
                  )}
                />
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
});
