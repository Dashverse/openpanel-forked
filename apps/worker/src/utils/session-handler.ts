import { getTime } from '@openpanel/common';
import { type IServiceCreateEventPayload, createEvent } from '@openpanel/db';
import {
  type EventsQueuePayloadCreateSessionEnd,
  sessionsQueue,
} from '@openpanel/queue';
import type { Job } from 'bullmq';
import { logger } from './logger';

export const SESSION_TIMEOUT = 1000 * 60 * 30;

const getSessionEndJobId = (projectId: string, deviceId: string) =>
  `sessionEnd:${projectId}:${deviceId}`;

export async function createSessionStart({
  payload,
}: {
  payload: IServiceCreateEventPayload;
}) {
  return createEvent({
    ...payload,
    name: 'session_start',
    createdAt: new Date(getTime(payload.createdAt) - 100),
  });
}

export async function createSessionEndJob({
  payload,
}: {
  payload: IServiceCreateEventPayload;
}) {
  const jobId = getSessionEndJobId(payload.projectId, payload.deviceId);
  // The job is keyed by deviceId, and BullMQ's add() is a no-op when a job
  // with the same id already exists. When a client rotates its session_id
  // (Phase 5) a stale delayed job still carries the OLD session's payload —
  // without replacing it, later events keep matching the old session and
  // spawn duplicate session_start events. Remove any existing delayed job so
  // the new one carries the current session's payload.
  const existing = await sessionsQueue.getJob(jobId);
  if (existing) {
    await existing.remove().catch(() => {
      // Job may be active/locked — remove can throw. Fall back to the add
      // below (a no-op if the id is still present); non-fatal.
    });
  }
  return sessionsQueue.add(
    'session',
    {
      type: 'createSessionEnd',
      payload,
    },
    {
      delay: SESSION_TIMEOUT,
      jobId,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 200,
      },
    },
  );
}

export async function getSessionEnd({
  projectId,
  currentDeviceId,
  previousDeviceId,
  profileId,
}: {
  projectId: string;
  currentDeviceId: string;
  previousDeviceId: string;
  profileId: string;
}) {
  const sessionEnd = await getSessionEndJob({
    projectId,
    currentDeviceId,
    previousDeviceId,
  });

  if (sessionEnd) {
    const existingSessionIsAnonymous =
      sessionEnd.job.data.payload.profileId ===
      sessionEnd.job.data.payload.deviceId;

    const eventIsIdentified =
      profileId && sessionEnd.job.data.payload.profileId !== profileId;

    if (existingSessionIsAnonymous && eventIsIdentified) {
      await sessionEnd.job.updateData({
        ...sessionEnd.job.data,
        payload: {
          ...sessionEnd.job.data.payload,
          profileId,
        },
      });
    }

    await sessionEnd.job.changeDelay(SESSION_TIMEOUT);
    return sessionEnd.job.data.payload;
  }

  return null;
}

export async function getSessionEndJob(args: {
  projectId: string;
  currentDeviceId: string;
  previousDeviceId: string;
  retryCount?: number;
}): Promise<{
  deviceId: string;
  job: Job<EventsQueuePayloadCreateSessionEnd>;
} | null> {
  const { retryCount = 0 } = args;

  if (retryCount >= 6) {
    throw new Error('Failed to get session end');
  }

  async function handleJobStates(
    job: Job<EventsQueuePayloadCreateSessionEnd>,
    deviceId: string,
  ): Promise<{
    deviceId: string;
    job: Job<EventsQueuePayloadCreateSessionEnd>;
  } | null> {
    const state = await job.getState();
    if (state !== 'delayed') {
      logger.debug(`[session-handler] Session end job is in "${state}" state`, {
        state,
        retryCount,
        jobTimestamp: new Date(job.timestamp).toISOString(),
        jobDelta: Date.now() - job.timestamp,
        jobId: job.id,
        payload: job.data.payload,
      });
    }

    if (state === 'delayed' || state === 'waiting') {
      return { deviceId, job };
    }

    if (state === 'active') {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return getSessionEndJob({
        ...args,
        retryCount: retryCount + 1,
      });
    }

    if (state === 'completed') {
      await job.remove();
    }

    return null;
  }

  // Check current device job
  const currentJob = await sessionsQueue.getJob(
    getSessionEndJobId(args.projectId, args.currentDeviceId),
  );
  if (currentJob) {
    return await handleJobStates(currentJob, args.currentDeviceId);
  }

  // Check previous device job
  const previousJob = await sessionsQueue.getJob(
    getSessionEndJobId(args.projectId, args.previousDeviceId),
  );
  if (previousJob) {
    return await handleJobStates(previousJob, args.previousDeviceId);
  }

  // Create session
  return null;
}
