import type { IChartEventFilter } from '@openpanel/validation';

/**
 * Merge dashboard-level filters into a report's own `globalFilters`.
 *
 * Behaviour (MVP):
 * - AND-stacks dashboard filters on top of the report's filters.
 * - EXCEPT when a report filter already targets the SAME property `name` as a
 *   dashboard filter — in that case the dashboard filter REPLACES the report's
 *   clause on that key ("dashboard wins"). This avoids contradictory
 *   `A AND not-A` clauses that would silently return an empty result set.
 *
 * Dedupe is a simple key-based dedupe on `name`, which is sufficient for MVP.
 */
export function mergeDashboardFilters(
  reportGlobalFilters: IChartEventFilter[],
  dashboardFilters: IChartEventFilter[],
): IChartEventFilter[] {
  if (!dashboardFilters || dashboardFilters.length === 0) {
    return reportGlobalFilters ?? [];
  }

  const dashboardNames = new Set(dashboardFilters.map((filter) => filter.name));

  // Drop any report clause whose property name is also constrained by a
  // dashboard filter; the dashboard filter takes precedence for that key.
  const keptReportFilters = (reportGlobalFilters ?? []).filter(
    (filter) => !dashboardNames.has(filter.name),
  );

  return [...keptReportFilters, ...dashboardFilters];
}

/**
 * Parse the `filters` JSON stored on a Dashboard row into a typed, sanitized
 * `IChartEventFilter[]`. Guards against malformed/legacy shapes — anything that
 * isn't a well-formed filter object is dropped rather than throwing.
 */
export function parseSavedDashboardFilters(raw: unknown): IChartEventFilter[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const filter = item as Record<string, unknown>;
    if (typeof filter.name !== 'string' || typeof filter.operator !== 'string') {
      return [];
    }
    const value = Array.isArray(filter.value) ? filter.value : [];
    return [
      {
        id:
          typeof filter.id === 'string' && filter.id.length > 0
            ? filter.id
            : filter.name,
        name: filter.name,
        operator: filter.operator,
        value,
        ...(typeof filter.cohortId === 'string'
          ? { cohortId: filter.cohortId }
          : {}),
      } as IChartEventFilter,
    ];
  });
}

/**
 * Order/shape-insensitive equality for two dashboard filter sets, used to
 * decide whether the current (effective) filters differ from what's saved —
 * i.e. whether the Save control should be shown. Compares by
 * `name`/`operator`/sorted stringified `value`, ignoring `id` and array order.
 */
export function dashboardFiltersEqual(
  a: IChartEventFilter[],
  b: IChartEventFilter[],
): boolean {
  const normalize = (filters: IChartEventFilter[]) =>
    filters
      .map((filter) => ({
        name: filter.name,
        operator: filter.operator,
        cohortId: filter.cohortId ?? null,
        value: filter.value.map((v) => String(v)).sort(),
      }))
      .sort((x, y) =>
        `${x.name}|${x.operator}`.localeCompare(`${y.name}|${y.operator}`),
      );

  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
