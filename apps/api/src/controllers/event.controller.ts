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
import { currentTraceparent, withQueryContext } from '@openpanel/telemetry';
import { buildEventJobId } from '@/utils/event-job-id';
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

  // Bind narrowed value so the inner closure sees `string` (not
  // `string | null | undefined`) — TS can't propagate the `if (!projectId)`
  // narrowing across the async closure boundary otherwise.
  const projectIdOk: string = projectId;

  // Stamp OTel query context — every CH query fired downstream carries
  // project_id + endpoint in log_comment. See track.controller for the
  // longer-form comment on why.
  return withQueryContext(
    { project_id: projectIdOk, endpoint: '/event' },
    () => handlePostEvent(),
  );

  async function handlePostEvent() {
  const projectId = projectIdOk;

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
  const jobId = buildEventJobId([
    slug(request.body.name),
    timestamp,
    projectId,
    currentDeviceId,
    groupId,
  ]);
  // Stamp the CURRENT W3C traceparent so the worker consumer (different
  // process / pod) can bind its span as a child of THIS request's trace.
  const traceparent = currentTraceparent();
  const queueData: EventsQueuePayloadIncomingEvent['payload'] = {
    ...(traceparent ? { __traceparent: traceparent } : {}),
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
}
