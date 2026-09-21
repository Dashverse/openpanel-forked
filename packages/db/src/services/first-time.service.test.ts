import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFirstTimeSubquery, isFirstTime } from './first-time.service';

/**
 * Deterministic tests for the "first time for user" (all-time first) query
 * fragment. Everything here asserts on the generated SQL string / pure logic —
 * no ClickHouse, no Postgres, no network.
 *
 * The alias-resolution mode is driven by the PROFILE_ALIAS_DICT env var
 * (getProfileAliasDict reads it at call time), so we flip it per test.
 */

const PROJECT = 'proj_123';

// Count non-overlapping occurrences of a substring.
const count = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

// The base WHERE segment: everything between the subquery's WHERE and GROUP BY.
const whereSegment = (sql: string): string => {
  const start = sql.indexOf('WHERE project_id');
  const end = sql.indexOf('GROUP BY', start);
  return sql.slice(start, end);
};

describe('buildFirstTimeSubquery', () => {
  const priorDict = process.env.PROFILE_ALIAS_DICT;

  beforeEach(() => {
    // Default every test to dict-OFF; individual tests set it explicitly.
    process.env.PROFILE_ALIAS_DICT = '';
  });

  afterEach(() => {
    if (priorDict === undefined) {
      process.env.PROFILE_ALIAS_DICT = undefined;
      // biome-ignore lint/performance/noDelete: restore pristine env
      delete process.env.PROFILE_ALIAS_DICT;
    } else {
      process.env.PROFILE_ALIAS_DICT = priorDict;
    }
  });

  it('emits argMinIf / minIf and the global-first HAVING with no lower bound on the base min', () => {
    const sql = buildFirstTimeSubquery({
      projectId: PROJECT,
      eventName: 'signup',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    });

    // The single-pass per-person aggregation.
    expect(sql).toContain('argMinIf(e.profile_id, created_at,');
    expect(sql).toContain('minIf(created_at,');

    // Global-first-that-matches HAVING (exact fragment).
    expect(sql).toContain(
      'HAVING min(created_at) = first_in_range AND min(created_at) != toDateTime(0)',
    );

    // Upper bound on the base scan only — NO lower bound on the base min.
    // `created_at <=` appears exactly once (the base WHERE endDate bound); the
    // start bound `created_at >=` lives ONLY inside the two conditional legs.
    expect(count(sql, 'created_at <=')).toBe(1);
    expect(count(sql, 'created_at >=')).toBe(2); // argMinIf leg + minIf leg
    expect(whereSegment(sql)).not.toContain('created_at >=');

    // project + name pinned in the base WHERE (escaped).
    expect(sql).toContain(`project_id = '${PROJECT}'`);
    expect(sql).toContain("name = 'signup'");
  });

  it('places property filterConditions in the inRange/minIf leg only — never the base WHERE / base min', () => {
    const filter = "path = '/pricing'";
    const sql = buildFirstTimeSubquery({
      projectId: PROJECT,
      eventName: 'page_view',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
      filterConditions: [filter],
    });

    // The filter rides in BOTH conditional legs (argMinIf + minIf share
    // inRangeCond) — so exactly twice — and NOWHERE else.
    expect(count(sql, filter)).toBe(2);
    // Not hoisted into the outer/base WHERE.
    expect(whereSegment(sql)).not.toContain(filter);
    // And it sits alongside the start bound inside a leg.
    expect(sql).toContain(
      `(created_at >= toDateTime('2024-01-01 00:00:00')) AND (${filter})`,
    );
  });

  it('dict OFF: emits the profile_aliases join CTE and groups by coalesce(al.canonical, profile_id)', () => {
    process.env.PROFILE_ALIAS_DICT = '';
    const sql = buildFirstTimeSubquery({
      projectId: PROJECT,
      eventName: 'signup',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    });

    expect(sql).toContain('profile_aliases');
    expect(sql).toContain('argMax(profile_id, created_at) AS canonical');
    expect(sql).toContain('ON al.alias = e.device_id');
    expect(sql).toContain(
      "GROUP BY coalesce(nullIf(al.canonical, ''), e.profile_id)",
    );
    expect(sql).not.toContain('dictGet');
  });

  it('dict ON: groups by dictGetOrDefault and emits no profile_aliases join', () => {
    process.env.PROFILE_ALIAS_DICT = 'default.profile_alias_dict';
    const sql = buildFirstTimeSubquery({
      projectId: PROJECT,
      eventName: 'signup',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    });

    expect(sql).toContain('dictGetOrDefault');
    expect(sql).toContain("'default.profile_alias_dict'");
    // No al-CTE / profile_aliases scan when the dict resolves identity in-RAM.
    expect(sql).not.toContain('profile_aliases');
    expect(sql).not.toContain('al.canonical');
    expect(sql).toContain('GROUP BY coalesce(nullIf(dictGetOrDefault(');
  });

  it('honours a custom events table + alias', () => {
    process.env.PROFILE_ALIAS_DICT = 'd';
    const sql = buildFirstTimeSubquery({
      projectId: PROJECT,
      eventName: 'signup',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
      table: 'events_v2',
      alias: 'x',
    });
    expect(sql).toContain('FROM events_v2 AS x');
    expect(sql).toContain('argMinIf(x.profile_id, created_at,');
  });
});

describe('isFirstTime', () => {
  it('is true only when firstTime === true', () => {
    expect(isFirstTime({ firstTime: true })).toBe(true);
    expect(isFirstTime({ firstTime: false })).toBe(false);
    expect(isFirstTime({ firstTime: undefined })).toBe(false);
    expect(isFirstTime({} as { firstTime?: boolean })).toBe(false);
  });
});
