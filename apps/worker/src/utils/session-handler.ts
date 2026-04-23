import { getTime } from '@openpanel/common';
import { type IServiceCreateEventPayload, createEvent } from '@openpanel/db';
import {
  type EventsQueuePayloadCreateSessionEnd,
  sessionsQueue,
} from '@openpanel/queue';
import type { Job } from 'bullmq';
import { logger } from './logger';

export const SESSION_TIMEOUT = 1000 * 60 * 30;

// Local cache for BullMQ session-end Job objects.
// GroupMQ guarantees same deviceId always routes to the same worker pod
// (deterministic SHA1 sharding + static StatefulSet shard ownership),
// so this cache is safe and avoids 2-3 Redis calls per event on cache hit.
const SESSION_CACHE_TTL = 35 * 60 * 1000; // 35 min (session timeout + 5 min buffer)
const SESSION_CACHE_MAX_SIZE = 50_000;

const sessionEndCache = new Map<
  string,
  {
    job: Job<EventsQueuePayloadCreateSessionEnd>;
    deviceId: string;
    expiresAt: number;
  }
>();

// Sweep expired entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessionEndCache) {
    if (entry.expiresAt <= now) sessionEndCache.delete(key);
  }
}, 60_000).unref();

export function invalidateSessionEndCache(
  projectId: string,
  deviceId: string,
) {
  sessionEndCache.delete(getSessionEndJobId(projectId, deviceId));
}

export function clearSessionEndCache() {
  sessionEndCache.clear();
}

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
  const job = await sessionsQueue.add(
    'session',
    {
      type: 'createSessionEnd',
      payload,
    },
    {
      delay: SESSION_TIMEOUT,
      jobId: getSessionEndJobId(payload.projectId, payload.deviceId),
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 200,
      },
    },
  );

  // Cache locally to avoid Redis lookups on subsequent events
  const jobId = getSessionEndJobId(payload.projectId, payload.deviceId);
  if (sessionEndCache.size < SESSION_CACHE_MAX_SIZE) {
    sessionEndCache.set(jobId, {
      job,
      deviceId: payload.deviceId,
      expiresAt: Date.now() + SESSION_CACHE_TTL,
    });
  }

  return job;
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

  // Check local cache first (avoids Redis HGETALL + getState per event)
  const cachedCurrentKey = getSessionEndJobId(args.projectId, args.currentDeviceId);
  const cachedCurrent = sessionEndCache.get(cachedCurrentKey);
  if (cachedCurrent && cachedCurrent.expiresAt > Date.now()) {
    return { deviceId: cachedCurrent.deviceId, job: cachedCurrent.job };
  }

  const cachedPreviousKey = getSessionEndJobId(args.projectId, args.previousDeviceId);
  const cachedPrevious = sessionEndCache.get(cachedPreviousKey);
  if (cachedPrevious && cachedPrevious.expiresAt > Date.now()) {
    return { deviceId: cachedPrevious.deviceId, job: cachedPrevious.job };
  }

  // Cache miss — fall back to Redis
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
      // Populate cache on Redis fallback hit (cold start recovery)
      const cacheKey = getSessionEndJobId(args.projectId, deviceId);
      if (sessionEndCache.size < SESSION_CACHE_MAX_SIZE) {
        sessionEndCache.set(cacheKey, {
          job,
          deviceId,
          expiresAt: Date.now() + SESSION_CACHE_TTL,
        });
      }
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
