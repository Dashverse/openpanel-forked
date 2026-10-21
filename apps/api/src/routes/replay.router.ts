import * as controller from '@/controllers/replay.controller';
import type { FastifyPluginCallback } from 'fastify';

/** Dashboard-only (cookie session): registered inside the dashboard scope. */
const replayRouter: FastifyPluginCallback = async (fastify) => {
  fastify.route({
    method: 'GET',
    url: '/blocks',
    handler: controller.getReplayBlocks,
  });
};

export default replayRouter;
