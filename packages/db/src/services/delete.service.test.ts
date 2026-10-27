import { beforeEach, describe, expect, it, vi } from 'vitest';

const { commandMock } = vi.hoisted(() => ({ commandMock: vi.fn() }));

vi.mock('../clickhouse/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../clickhouse/client')>();
  return {
    TABLE_NAMES: real.TABLE_NAMES,
    // Plain names (non-clustered) so assertions can match table names directly.
    getReplicatedTableName: (table: string) => table,
    ch: {
      command: (args: {
        query: string;
        clickhouse_settings?: Record<string, string>;
      }) => commandMock(args),
    },
  };
});

vi.mock('../prisma-client', () => ({ db: {} }));

const {
  deleteFromClickhouse,
  CLICKHOUSE_PROJECT_TABLES,
  isUnknownTableError,
  isProjectDeletionDue,
} = await import('./delete.service');

class FakeClickHouseError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly type?: string,
  ) {
    super(message);
  }
}

const queriedTables = () =>
  commandMock.mock.calls.map(
    ([args]) => /(?:FROM|TABLE) (\S+)/.exec(args.query)?.[1],
  );

describe('deleteFromClickhouse', () => {
  beforeEach(() => {
    commandMock.mockReset();
  });

  it('issues one delete per project table, scoped to the project ids', async () => {
    commandMock.mockResolvedValue(undefined);

    await deleteFromClickhouse(['p1', "p'2"]);

    expect(commandMock).toHaveBeenCalledTimes(CLICKHOUSE_PROJECT_TABLES.length);
    expect(queriedTables()).toEqual(
      CLICKHOUSE_PROJECT_TABLES.map((t) => t.table),
    );
    for (const [args] of commandMock.mock.calls) {
      expect(args.query).toContain("WHERE project_id IN ('p1','p\\'2')");
    }
    expect(queriedTables()).not.toContain('cohort_events_mv');
  });

  it('uses ALTER TABLE … DELETE for materialized views, DELETE FROM otherwise', async () => {
    commandMock.mockResolvedValue(undefined);

    await deleteFromClickhouse(['p1']);

    const byTable = new Map(
      commandMock.mock.calls.map(([args]) => [
        /(?:FROM|TABLE) (\S+)/.exec(args.query)?.[1],
        args.query as string,
      ]),
    );
    expect(byTable.get('dau_mv')).toMatch(/^ALTER TABLE dau_mv DELETE WHERE/);
    expect(byTable.get('events_daily_stats')).toMatch(/^ALTER TABLE /);
    expect(byTable.get('events')).toMatch(/^DELETE FROM events WHERE/);
  });

  it('skips a missing table (UNKNOWN_TABLE, code 60) and keeps deleting the rest', async () => {
    commandMock.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes(' sessions ')) {
        throw new FakeClickHouseError(
          'Table default.sessions does not exist',
          '60',
          'UNKNOWN_TABLE',
        );
      }
    });

    await expect(deleteFromClickhouse(['p1'])).resolves.toBeUndefined();
    expect(commandMock).toHaveBeenCalledTimes(CLICKHOUSE_PROJECT_TABLES.length);
  });

  it('uses ALTER TABLE … DELETE for event_property_values_mv (has a projection)', async () => {
    commandMock.mockResolvedValue(undefined);

    await deleteFromClickhouse(['p1']);

    const entry = CLICKHOUSE_PROJECT_TABLES.find(
      (t) => t.table === 'event_property_values_mv',
    );
    expect(entry?.mutation).toBe('alter');
    const query = commandMock.mock.calls
      .map(([args]) => args.query as string)
      .find((q) => q.includes(' event_property_values_mv '));
    expect(query).toMatch(/^ALTER TABLE event_property_values_mv DELETE WHERE/);
  });

  it('submits every delete async (no sync wait on the server)', async () => {
    commandMock.mockResolvedValue(undefined);

    await deleteFromClickhouse(['p1']);

    for (const [args] of commandMock.mock.calls) {
      if (args.query.startsWith('ALTER TABLE')) {
        expect(args.clickhouse_settings).toEqual({ mutations_sync: '0' });
      } else {
        expect(args.clickhouse_settings).toEqual({
          lightweight_deletes_sync: '0',
        });
      }
    }
  });

  it('tries every table, then throws one AggregateError naming the failed ones', async () => {
    const boomProfiles = new FakeClickHouseError(
      'Memory limit exceeded',
      '241',
    );
    const boomDau = new FakeClickHouseError('Timeout exceeded', '159');
    commandMock.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes(' profiles ')) throw boomProfiles;
      if (query.includes(' dau_mv ')) throw boomDau;
      if (query.includes(' sessions ')) {
        throw new FakeClickHouseError('missing', '60', 'UNKNOWN_TABLE');
      }
    });

    const error = await deleteFromClickhouse(['p1']).then(
      () => undefined,
      (e: unknown) => e,
    );

    // Every table was still attempted after the first failure.
    expect(commandMock).toHaveBeenCalledTimes(CLICKHOUSE_PROJECT_TABLES.length);
    expect(error).toBeInstanceOf(AggregateError);
    const agg = error as AggregateError;
    expect(agg.errors).toEqual([boomProfiles, boomDau]);
    expect(agg.message).toContain('2 table(s): profiles, dau_mv');
    // The missing table only warns, it is not reported as a failure.
    expect(agg.message).not.toContain('sessions');
  });

  it('does nothing for an empty project list', async () => {
    await deleteFromClickhouse([]);
    expect(commandMock).not.toHaveBeenCalled();
  });
});

describe('isUnknownTableError', () => {
  it('matches code 60 / UNKNOWN_TABLE only', () => {
    expect(isUnknownTableError(new FakeClickHouseError('x', '60'))).toBe(true);
    expect(
      isUnknownTableError(new FakeClickHouseError('x', '0', 'UNKNOWN_TABLE')),
    ).toBe(true);
    expect(isUnknownTableError(new FakeClickHouseError('x', '241'))).toBe(
      false,
    );
    expect(isUnknownTableError(new Error('socket hang up'))).toBe(false);
    expect(isUnknownTableError(undefined)).toBe(false);
  });
});

describe('isProjectDeletionDue', () => {
  const now = new Date('2026-10-27T12:00:00Z');

  it('is due once deleteAt is now or in the past', () => {
    expect(isProjectDeletionDue(now, now)).toBe(true);
    expect(isProjectDeletionDue(new Date('2026-10-27T11:00:00Z'), now)).toBe(
      true,
    );
  });

  it('is not due before deleteAt, or when no deletion is scheduled', () => {
    expect(isProjectDeletionDue(new Date('2026-10-27T12:00:01Z'), now)).toBe(
      false,
    );
    expect(isProjectDeletionDue(null, now)).toBe(false);
    expect(isProjectDeletionDue(undefined, now)).toBe(false);
  });
});
