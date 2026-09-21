import { resolveIdentityCore } from '@openpanel/db';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpAuthContext } from '../../auth';
import {
  projectIdSchema,
  resolveProjectId,
  withErrorHandling,
} from '../shared';

/**
 * resolve_identity — fork-only. Maps an anonymous/device id to its canonical
 * person (post-login profile) and lists all anon aliases that resolve to it,
 * using profile_aliases (the #428 identity graph). Neither upstream's MCP nor
 * Mixpanel/PostHog expose this.
 */
export function registerIdentityTools(
  server: McpServer,
  context: McpAuthContext,
) {
  server.tool(
    'resolve_identity',
    'Resolve an id to its canonical person: given an anonymous/device id it returns the logged-in profile id it belongs to, and given a profile id it lists the anonymous ids that map to it. Use to reconcile pre-login and post-login activity for the same user.',
    {
      projectId: projectIdSchema(context),
      id: z
        .string()
        .describe('A profile id or an anonymous/device id to resolve.'),
    },
    async ({ projectId: p, id }) =>
      withErrorHandling(
        async () => {
          const projectId = await resolveProjectId(context, p);
          return resolveIdentityCore({ projectId, id });
        },
        { tool: 'resolve_identity', context },
      ),
  );
}
