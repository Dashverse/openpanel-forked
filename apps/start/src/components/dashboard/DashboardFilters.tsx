import { CohortFilterRow } from '@/components/events/filters/cohort-filter-row';
import { FilterRow } from '@/components/events/filters/filter-row';
import { PropertyPicker } from '@/components/property-picker';
import { Button } from '@/components/ui/button';
import { useAppParams } from '@/hooks/use-app-params';
import type {
  IChartEventFilter,
  IChartEventFilterOperator,
  IChartEventFilterValue,
} from '@openpanel/validation';
import { FilterIcon } from 'lucide-react';

// Narrower value control for the dashboard bar: the Events page keeps its fixed
// `w-[220px]`, but on the dashboard short values looked oversized, so size to
// content within sensible bounds. Paired with `valueMaxVisibleChips` below, the
// control collapses many selected values to "first-two + N more" on one line
// instead of ballooning the bar.
const COMPACT_VALUE_CLASSNAME = 'min-w-[7rem] max-w-[15rem] w-auto';

// Show at most two selected value chips on the dashboard bar; the rest collapse
// into a "+N more" badge (Mixpanel board-filter style).
const DASHBOARD_VALUE_MAX_CHIPS = 2;

// Operators whose control accepts multiple values (the combobox). Everything
// else is single-value (a text input) or valueless (isNull/isNotNull), so we
// trim the value down to at most one entry when switching to them.
const MULTI_VALUE_OPERATORS: IChartEventFilterOperator[] = ['is', 'isNot'];

/**
 * Dashboard-level filter bar. A filter set here is merged into every report's
 * `globalFilters` (see `mergeDashboardFilters`), so it applies to every chart
 * on the dashboard.
 *
 * Fully CONTROLLED: the active filter set lives in the route's local React
 * state (seeded from the dashboard's saved filters, the Mixpanel model —
 * transient edits in memory, persisted on Save). Every edit is a pure array
 * operation that calls `onChange` with the next set; removing the last filter
 * just yields an empty array, so a deleted filter can't reappear.
 *
 * The Save control is owned by the dashboard route (rendered at the end of the
 * header row), not here.
 */
export function DashboardFilters({
  filters,
  onChange,
  section = 'all',
}: {
  filters: IChartEventFilter[];
  onChange: (next: IChartEventFilter[]) => void;
  /**
   * Which part to render. The dashboard header splits the bar across two rows:
   * the `trigger` (Add filter button) stays inline with the date/interval
   * controls up top so it's always discoverable, while the active filter
   * `rows` flow onto their own strip below so many filters never push the
   * Save/Search/Reload actions around. `all` renders both (single-strip usage).
   */
  section?: 'trigger' | 'rows' | 'all';
}) {
  const { projectId } = useAppParams();

  const removeFilter = (id: string | undefined) =>
    onChange(filters.filter((filter) => filter.id !== id));

  const changeOperator = (
    id: string | undefined,
    operator: IChartEventFilterOperator,
  ) =>
    onChange(
      filters.map((filter) =>
        filter.id === id
          ? {
              ...filter,
              operator,
              value: MULTI_VALUE_OPERATORS.includes(operator)
                ? filter.value
                : filter.value.slice(0, 1),
            }
          : filter,
      ),
    );

  const changeValue = (
    id: string | undefined,
    value: IChartEventFilterValue[],
  ) =>
    onChange(
      filters.map((filter) =>
        filter.id === id ? { ...filter, value } : filter,
      ),
    );

  const changeProperty = (id: string | undefined, next: IChartEventFilter) =>
    onChange(
      filters.map((filter) =>
        filter.id === id ? { ...next, id: filter.id } : filter,
      ),
    );

  // The rows strip only exists once there's something to show; an empty
  // `rows`-only render collapses to nothing (no empty gap in the header).
  if (section === 'rows' && filters.length === 0) {
    return null;
  }

  const addFilterButton = (
    <PropertyPicker
      projectId={projectId}
      categories={['event', 'profile', 'cohort']}
      onSelect={(action) => {
        // Guard duplicates: the property is already a filter on the bar.
        if (filters.some((filter) => filter.name === action.value)) {
          return;
        }
        onChange([
          ...filters,
          {
            // Stable, name-independent id: keying by property name would collide
            // if a filter is renamed (country→platform) and then `country` is
            // re-added — two rows with id "country" → duplicate React keys and
            // edits/removals hitting both. changeProperty preserves this id.
            id: crypto.randomUUID(),
            name: action.value,
            operator: action.cohortId ? 'inCohort' : 'is',
            value: [],
            ...(action.cohortId ? { cohortId: action.cohortId } : {}),
          } as IChartEventFilter,
        ]);
      }}
    >
      <Button variant="outline" size="sm" icon={FilterIcon}>
        Add filter
      </Button>
    </PropertyPicker>
  );

  if (section === 'trigger') {
    return addFilterButton;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {filters.map((filter) => {
        const isCohort =
          filter.operator === 'inCohort' ||
          filter.operator === 'notInCohort' ||
          filter.name.startsWith('cohort:');

        const exclude = filters
          .filter((item) => item.id !== filter.id)
          .map((item) => item.name);

        if (isCohort) {
          return (
            <CohortFilterRow
              key={filter.id}
              projectId={projectId}
              event="*"
              filter={filter}
              className="gap-2"
              exclude={exclude}
              onChangeProperty={(next) => changeProperty(filter.id, next)}
              onChangeOperator={(operator) =>
                changeOperator(filter.id, operator)
              }
              onRemove={() => removeFilter(filter.id)}
            />
          );
        }

        return (
          <FilterRow
            key={filter.id}
            projectId={projectId}
            event="*"
            filter={filter}
            className="gap-2"
            valueClassName={COMPACT_VALUE_CLASSNAME}
            valueMaxVisibleChips={DASHBOARD_VALUE_MAX_CHIPS}
            exclude={exclude}
            onChangeProperty={(next) => changeProperty(filter.id, next)}
            onChangeOperator={(operator) => changeOperator(filter.id, operator)}
            onChangeValue={(value) => changeValue(filter.id, value)}
            onRemove={() => removeFilter(filter.id)}
          />
        );
      })}

      {/* In single-strip (`all`) mode the trigger trails the rows; when the
          header splits the bar, the trigger lives up top instead. */}
      {section === 'all' && addFilterButton}
    </div>
  );
}
