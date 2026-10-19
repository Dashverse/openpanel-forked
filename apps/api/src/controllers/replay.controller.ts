import { PassThrough } from 'node:stream';
import { REPLAY_FRAMES_CONTENT_TYPE } from '@openpanel/common';
import {
  ReplayBlockRequestError,
  isReplayAbortError,
  prepareReplayBlockData,
  runWithAlsSession,
} from '@openpanel/db';
import { withQueryContext } from '@openpanel/telemetry';
import { getProjectAccess } from '@openpanel/trpc';
import type { FastifyReply, FastifyRequest } from 'fastify';

type BlocksQuery = {
  projectId?: string;
  sessionId?: string;
  windowId?: string;
  source?: string;
  /** Comma-separated block keys from session.replayBlocks (max 100). */
  keys?: string;
};

/**
 * GET /replay/blocks: raw replay blocks for the dashboard player, framed
 * binary (see @openpanel/common replay-frames.ts). Same auth as the dashboard
 * tRPC protectedProcedure: a valid session cookie (401 otherwise) and access
 * to the project (403), with the request's session id in the ALS scope like
 * sessionScopeMiddleware.
 *
 * A client cancel (connection closed before the response finished) aborts the
 * Azure / ClickHouse reads and just stops: no fallback to another store. A
 * genuine read failure ends the response without the terminator, so the
 * client sees a truncated (failed) request.
 */
export async function getReplayBlocks(
  request: FastifyRequest<{ Querystring: BlocksQuery }>,
  reply: FastifyReply,
) {
  const userId = request.session?.userId;
  if (!userId) {
    return reply.status(401).send({ error: 'Not authenticated' });
  }
  const { projectId, sessionId, source } = request.query;
  const windowId = request.query.windowId ?? '';
  const keys = (request.query.keys ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (!projectId || !sessionId || !source) {
    return reply
      .status(400)
      .send({ error: 'projectId, sessionId and source are required' });
  }

  const abort = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) abort.abort();
  });

  const alsSessionId = request.session?.session?.id ?? null;
  return runWithAlsSession(alsSessionId, () =>
    withQueryContext(
      { endpoint: 'replay.blocks', project_id: projectId, user_id: userId },
      async () => {
        const access = await getProjectAccess({ userId, projectId });
        if (!access) {
          return reply
            .status(403)
            .send({ error: 'You do not have access to this project' });
        }

        let prepared: Awaited<ReturnType<typeof prepareReplayBlockData>>;
        try {
          prepared = await prepareReplayBlockData({
            sessionId,
            projectId,
            windowId,
            source,
            keys,
            signal: abort.signal,
          });
        } catch (error) {
          if (error instanceof ReplayBlockRequestError) {
            return reply.status(error.status).send({ error: error.message });
          }
          if (isReplayAbortError(error, abort.signal)) {
            return reply;
          }
          throw error;
        }

        const stream = new PassThrough();
        const write = (bytes: Uint8Array): void | Promise<void> => {
          if (stream.write(bytes)) return;
          return new Promise<void>((resolve) => {
            const done = () => {
              stream.off('drain', done);
              stream.off('close', done);
              abort.signal.removeEventListener('abort', done);
              resolve();
            };
            stream.once('drain', done);
            stream.once('close', done);
            abort.signal.addEventListener('abort', done, { once: true });
          });
        };

        const started = Date.now();
        prepared
          .run(write)
          .then(() => {
            stream.end();
          })
          .catch((error) => {
            if (isReplayAbortError(error, abort.signal)) {
              stream.destroy();
              return;
            }
            request.log.error('replay blocks read failed', {
              error,
              projectId,
              sessionId,
              windowId,
              source: prepared.source,
              blocks: prepared.blockCount,
              elapsedMs: Date.now() - started,
            });
            stream.destroy(error instanceof Error ? error : undefined);
          });

        return reply
          .header('content-type', REPLAY_FRAMES_CONTENT_TYPE)
          .header('cache-control', 'private, no-store')
          .header('x-replay-source', prepared.source)
          .send(stream);
      },
    ),
  );
}
