import type { Job } from 'bullmq';

import {
  eventBuffer,
  profileBuffer,
  replayBuffer,
  sessionBuffer,
} from '@openpanel/db';
import type { CronQueuePayload } from '@openpanel/queue';
import { withSpan } from '@openpanel/telemetry';

import { customAlerts } from './cron.custom-alerts';
import { jobdeleteProjects } from './cron.delete-projects';
import { firstEvent } from './cron.first-event';
import { materializeColumns } from './cron.materialize-columns';
import { ping } from './cron.ping';
import { salt } from './cron.salt';

// Cron dispatcher. Each buffer flush gets its own root span (crons are not
// children of any request) so the trace waterfall in SigNoz becomes: cron
// span → ch.insert child (from packages/db Proxy) → whatever else the flush
// does. The CH log_comment carries this trace_id, letting a post-facto
// system.query_log join answer "which flush caused the memory spike at 12:04".
export async function cronJob(job: Job<CronQueuePayload>) {
  switch (job.data.type) {
    case 'salt': {
      return await withSpan('worker.cron.salt', () => salt());
    }
    case 'flushEvents': {
      return await withSpan('worker.cron.flushEvents', () =>
        eventBuffer.tryFlush(),
      );
    }
    case 'flushProfiles': {
      return await withSpan('worker.cron.flushProfiles', () =>
        profileBuffer.tryFlush(),
      );
    }
    case 'flushSessions': {
      return await withSpan('worker.cron.flushSessions', () =>
        sessionBuffer.tryFlush(),
      );
    }
    case 'flushReplays': {
      return await withSpan('worker.cron.flushReplays', () =>
        replayBuffer.tryFlush(),
      );
    }
    case 'ping': {
      return await ping();
    }
    case 'deleteProjects': {
      return await jobdeleteProjects(job);
    }
    case 'materializeColumns': {
      return await materializeColumns({
        dryRun: job.data.dryRun ?? false,
        threshold: job.data.threshold ?? 150,
      });
    }
    case 'customAlerts': {
      return await customAlerts();
    }
    case 'firstEvent': {
      return await firstEvent();
    }
  }
}
