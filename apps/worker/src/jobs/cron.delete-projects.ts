import { logger } from '@/utils/logger';
import { db, deleteFromClickhouse, deleteProjects } from '@openpanel/db';
import type { CronQueuePayload } from '@openpanel/queue';
import type { Job } from 'bullmq';

export async function jobdeleteProjects(job: Job<CronQueuePayload>) {
  const projects = await db.project.findMany({
    where: {
      deleteAt: {
        lte: new Date(),
      },
    },
  });

  if (projects.length === 0) {
    return;
  }

  const projectIds = projects.map((project) => project.id);

  logger.info('Deleting projects', {
    projects,
  });

  // ClickHouse FIRST: if it throws, the Postgres rows (with deleteAt in the
  // past) are kept and this hourly cron retries the whole delete next run.
  // deleteFromClickhouse is idempotent, so re-running it is safe. Deleting the
  // Postgres rows first would orphan the ClickHouse data permanently.
  await deleteFromClickhouse(projectIds);

  await deleteProjects(projectIds);

  logger.info(`Deleted ${projects.length} projects`, {
    projects,
  });
}
