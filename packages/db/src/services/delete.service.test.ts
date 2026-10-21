import { beforeEach, describe, expect, it, vi } from 'vitest';

const { commandMock } = vi.hoisted(() => ({ commandMock: vi.fn() }));

vi.mock('../clickhouse/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../clickhouse/client')>();
  return {
    TABLE_NAMES: real.TABLE_NAMES,
    // Plain names (non-clustered) so assertions can match table names directly.
    getReplicatedTableName: (table: string) => table,
    ch: { command: (args: { query: string }) => commandMock(args) },
  };
});

vi.mock('../prisma-client', () => ({ db: {} }));

const { deleteFromClickhouse, CLICKHOUSE_PROJECT_TABLES, isUnknownTableError } =
  await import('./delete.service');

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

  it('rethrows any other error and stops', async () => {
    const boom = new FakeClickHouseError('Memory limit exceeded', '241');
    commandMock.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes(' profiles ')) throw boom;
    });

    await expect(deleteFromClickhouse(['p1'])).rejects.toBe(boom);
    const idx = CLICKHOUSE_PROJECT_TABLES.findIndex(
      (t) => t.table === 'profiles',
    );
    expect(commandMock).toHaveBeenCalledTimes(idx + 1);
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
