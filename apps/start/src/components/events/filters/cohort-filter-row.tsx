import { RenderDots } from '@/components/ui/RenderDots';
import { Button } from '@/components/ui/button';
import { DropdownMenuComposed } from '@/components/ui/dropdown-menu';
import { useCohorts } from '@/hooks/use-cohorts';
import type {
  IChartEventFilter,
  IChartEventFilterOperator,
} from '@openpanel/validation';
import { Trash2 } from 'lucide-react';

interface CohortFilterRowProps {
  projectId: string;
  filter: IChartEventFilter;
  onChangeOperator: (operator: IChartEventFilterOperator) => void;
  onRemove: () => void;
}

export function CohortFilterRow({
  projectId,
  filter,
  onChangeOperator,
  onRemove,
}: CohortFilterRowProps) {
  const { items: cohorts } = useCohorts({ projectId, includeCount: false });

  const cohortId = filter.cohortId ?? filter.name.split(':')[1];
  const cohort = cohorts.find((item) => item.id === cohortId);
  const isNotIn = filter.operator === 'notInCohort';

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <DropdownMenuComposed
        onChange={onChangeOperator}
        items={[
          { value: 'inCohort', label: 'In cohort' },
          { value: 'notInCohort', label: 'Not in cohort' },
        ]}
        label="Operator"
      >
        <Button variant="outline" size="sm" className="whitespace-nowrap">
          {isNotIn ? 'Not in cohort' : 'In cohort'}
        </Button>
      </DropdownMenuComposed>
      <div className="flex h-8 w-fit min-w-0 max-w-[28rem] items-center overflow-hidden rounded-md border bg-background px-2.5 text-sm font-medium">
        <RenderDots className="min-w-0 truncate" truncate>
          {cohort?.name ?? cohortId ?? filter.name}
        </RenderDots>
      </div>
      <Button variant="ghost" size="icon" onClick={onRemove}>
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}
