import type { CronQueuePayload } from '@openpanel/queue';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findManyMock, deleteFromClickhouseMock, deleteProjectsMock } =
  vi.hoisted(() => ({
    findManyMock: vi.fn(),
    deleteFromClickhouseMock: vi.fn(),
    deleteProjectsMock: vi.fn(),
  }));

vi.mock('@openpanel/db', () => ({
  db: { project: { findMany: findManyMock } },
  deleteFromClickhouse: deleteFromClickhouseMock,
  deleteProjects: deleteProjectsMock,
}));

vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { jobdeleteProjects } = await import('./cron.delete-projects');

const job = {} as Job<CronQueuePayload>;

describe('jobdeleteProjects', () => {
  beforeEach(() => {
    findManyMock.mockReset();
    deleteFromClickhouseMock.mockReset();
    deleteProjectsMock.mockReset();
  });

  it('does nothing when no project is due', async () => {
    findManyMock.mockResolvedValue([]);

    await jobdeleteProjects(job);

    expect(deleteFromClickhouseMock).not.toHaveBeenCalled();
    expect(deleteProjectsMock).not.toHaveBeenCalled();
  });

  it('deletes ClickHouse data before the Postgres rows', async () => {
    findManyMock.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
    const order: string[] = [];
    deleteFromClickhouseMock.mockImplementation(async () => {
      order.push('clickhouse');
    });
    deleteProjectsMock.mockImplementation(async () => {
      order.push('postgres');
    });

    await jobdeleteProjects(job);

    expect(deleteFromClickhouseMock).toHaveBeenCalledWith(['p1', 'p2']);
    expect(deleteProjectsMock).toHaveBeenCalledWith(['p1', 'p2']);
    expect(order).toEqual(['clickhouse', 'postgres']);
  });

  it('skips deleteProjects when deleteFromClickhouse throws, so the next run retries', async () => {
    findManyMock.mockResolvedValue([{ id: 'p1' }]);
    const boom = new AggregateError([], 'ClickHouse delete failed');
    deleteFromClickhouseMock.mockRejectedValue(boom);

    await expect(jobdeleteProjects(job)).rejects.toBe(boom);

    expect(deleteFromClickhouseMock).toHaveBeenCalledWith(['p1']);
    expect(deleteProjectsMock).not.toHaveBeenCalled();
  });
});
