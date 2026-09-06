import { FilterPropertyPicker } from '@/components/filter-property-picker';
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
  event?: string;
  filter: IChartEventFilter;
  onChangeOperator: (operator: IChartEventFilterOperator) => void;
  onRemove: () => void;
  onChangeProperty: (filter: IChartEventFilter) => void;
  exclude?: string[];
}

export function CohortFilterRow({
  projectId,
  event,
  filter,
  onChangeOperator,
  onRemove,
  onChangeProperty,
  exclude,
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
      <FilterPropertyPicker
        projectId={projectId}
        event={event}
        filter={filter}
        onChange={onChangeProperty}
        exclude={exclude}
        label={cohort?.name ?? cohortId ?? filter.name}
      />
      <Button
        variant="ghost"
        size="icon"
        aria-label="Remove filter"
        onClick={onRemove}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}
