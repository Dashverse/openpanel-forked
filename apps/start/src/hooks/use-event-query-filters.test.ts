import { beforeEach, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => ({
  filters: [] as ReturnType<typeof eventQueryFiltersParser.parse>,
}));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const useCallback = (callback: unknown) => callback;
  return {
    ...actual,
    useCallback,
    default: { ...actual, useCallback },
  };
});
vi.mock('nuqs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('nuqs')>()),
  useQueryState: () => [
    query.filters,
    (update: (filters: typeof query.filters) => typeof query.filters) => {
      query.filters = update(query.filters);
    },
  ],
}));

import {
  eventQueryFiltersParser,
  useEventQueryFilters,
} from './use-event-query-filters';

beforeEach(() => {
  query.filters = eventQueryFiltersParser.parse(
    'country,is,India;browser,is,Chrome',
  );
});

it('replaces a property in place and serializes its new name', () => {
  const [, , , , replaceFilter] = useEventQueryFilters();
  replaceFilter('country', { name: 'city', operator: 'is' });
  expect(query.filters).toEqual([
    { id: 'country', name: 'city', operator: 'is', value: [] },
    { id: 'browser', name: 'browser', operator: 'is', value: ['Chrome'] },
  ]);
  expect(eventQueryFiltersParser.serialize(query.filters!)).toBe(
    'city,is,;browser,is,Chrome',
  );
});

it('does not overwrite another filter or clear a reselected property', () => {
  const [, , , , replaceFilter] = useEventQueryFilters();
  const previous = query.filters;
  replaceFilter('country', { name: 'browser', operator: 'is' });
  replaceFilter('country', { name: 'country', operator: 'is' });
  expect(query.filters).toBe(previous);
});

it('keeps row IDs unique when adding the previous property again', () => {
  const [, setFilter, , , replaceFilter] = useEventQueryFilters();
  replaceFilter('country', { name: 'cohort:members', operator: 'inCohort' });
  setFilter('country', [], 'is');
  expect(new Set(query.filters!.map((filter) => filter.id)).size).toBe(3);
  expect(
    eventQueryFiltersParser.parse(
      eventQueryFiltersParser.serialize(query.filters!),
    )![0],
  ).toMatchObject({ name: 'cohort:members', operator: 'inCohort', value: [] });
});
