import type { FastifyReply, FastifyRequest } from 'fastify';

import { generateDeviceId, parseUserAgent } from '@openpanel/common/server';
import { getSalts } from '@openpanel/db';
import {
  type EventsQueuePayloadIncomingEvent,
  getEventsGroupQueueShard,
  produceIncomingEvent,
  shouldUseKafka,
} from '@openpanel/queue';
import type { PostEventPayload } from '@openpanel/sdk';

import { generateId, slug } from '@openpanel/common';
import { getGeoLocation } from '@openpanel/geo';
import { getStringHeaders, getTimestamp } from './track.controller';

export async function postEvent(
  request: FastifyRequest<{
    Body: PostEventPayload;
  }>,
  reply: FastifyReply,
) {
  const { timestamp, isTimestampFromThePast } = getTimestamp(
    request.timestamp,
    request.body,
  );
  const ip = request.clientIp;
  const ua = request.headers['user-agent'];
  const projectId = request.client?.projectId;
  const headers = getStringHeaders(request.headers);

  if (!projectId) {
    reply.status(400).send('missing origin');
    return;
  }

  const [salts, geo] = await Promise.all([getSalts(), getGeoLocation(ip)]);
  const currentDeviceId = ua
    ? generateDeviceId({
        salt: salts.current,
        origin: projectId,
        ip,
        ua,
      })
    : '';
  const previousDeviceId = ua
    ? generateDeviceId({
        salt: salts.previous,
        origin: projectId,
        ip,
        ua,
      })
    : '';

  const uaInfo = parseUserAgent(ua, request.body?.properties);
  const groupId = uaInfo.isServer
    ? request.body?.profileId
      ? `${projectId}:${request.body?.profileId}`
      : `${projectId}:${generateId()}`
    : currentDeviceId;
  const jobId = [
    slug(request.body.name),
    timestamp,
    projectId,
    currentDeviceId,
    groupId,
  ]
    .filter(Boolean)
    .join('-');
  const queueData: EventsQueuePayloadIncomingEvent['payload'] = {
    projectId,
    headers,
    event: {
      ...request.body,
      timestamp,
      isTimestampFromThePast,
    },
    uaInfo,
    geo,
    currentDeviceId,
    previousDeviceId,
  };

  const partitionKey = groupId || generateId();

  if (shouldUseKafka(projectId)) {
    await produceIncomingEvent(queueData, partitionKey);
  } else {
    await getEventsGroupQueueShard(partitionKey).add({
      orderMs: new Date(timestamp).getTime(),
      data: queueData,
      groupId,
      jobId,
    });
  }

  reply.status(202).send('ok');
}
