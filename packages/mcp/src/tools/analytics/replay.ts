import { getSessionReplayCore } from '@openpanel/db';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpAuthContext } from '../../auth';
import {
  projectIdSchema,
  resolveProjectId,
  withErrorHandling,
} from '../shared';

/**
 * get_session_replay — returns dashboard deep-links to session recordings
 * (never the recording data). By sessionId → one link; by user → their recent
 * sessions that have a replay. Coverage isn't 100%; returns a note when none.
 */
export function registerReplayTools(
  server: McpServer,
  context: McpAuthContext,
) {
  server.tool(
    'get_session_replay',
    "Get shareable links to session replays (screen recordings). Pass a sessionId for that session, or a profileId to list a user's recent sessions that have a recording. Returns links only — open them in the browser to watch.",
    {
      projectId: projectIdSchema(context),
      sessionId: z
        .string()
        .optional()
        .describe('A specific session id to get the replay link for.'),
      profileId: z
        .string()
        .optional()
        .describe("A user id to list that user's sessions with replays."),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ projectId: p, sessionId, profileId, limit }) =>
      withErrorHandling(
        async () => {
          const projectId = await resolveProjectId(context, p);
          return getSessionReplayCore({
            projectId,
            organizationId: context.organizationId,
            sessionId,
            profileId,
            limit,
          });
        },
        { tool: 'get_session_replay', context },
      ),
  );
}
