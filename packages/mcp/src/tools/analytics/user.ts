import {
  getProfileCore,
  getSessionsCore,
  getUserJourneyCore,
  listEventsCore,
} from '@openpanel/db';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpAuthContext } from '../../auth';
import {
  projectIdSchema,
  resolveDateRange,
  resolveProjectId,
  withErrorHandling,
  zDateRange,
} from '../shared';

/** User-centric tools: profile, event stream, sessions, and the unified journey. */
export function registerUserTools(server: McpServer, context: McpAuthContext) {
  server.tool(
    'get_user_journey',
    "A single user's full journey from any id. Resolves the id to its canonical person (unifying pre-login/anonymous and post-login activity), then returns their profile, recent sessions (with replay links where a recording exists), and a chronological event timeline across all their ids.",
    {
      projectId: projectIdSchema(context),
      id: z
        .string()
        .describe('Any profile id or anonymous/device id for the user.'),
      ...zDateRange,
      eventLimit: z.number().int().min(1).max(500).optional(),
    },
    async ({ projectId: p, id, startDate: sd, endDate: ed, eventLimit }) =>
      withErrorHandling(
        async () => {
          const projectId = await resolveProjectId(context, p);
          const { startDate, endDate } = resolveDateRange(sd, ed);
          return getUserJourneyCore({
            projectId,
            organizationId: context.organizationId,
            id,
            startDate,
            endDate,
            eventLimit,
          });
        },
        { tool: 'get_user_journey', context },
      ),
  );

  server.tool(
    'list_events',
    'List raw events, newest first — for a whole project or one user. For a user, pass their profileId (anonymous/device ids are resolved and merged automatically). Optionally filter by event names and date range.',
    {
      projectId: projectIdSchema(context),
      profileId: z
        .string()
        .optional()
        .describe(
          'Restrict to one user (any id — resolved + identity-merged).',
        ),
      events: z
        .array(z.string())
        .optional()
        .describe('Only these event names (exact, case-sensitive).'),
      ...zDateRange,
      limit: z.number().int().min(1).max(500).optional(),
    },
    async ({
      projectId: p,
      profileId,
      events,
      startDate: sd,
      endDate: ed,
      limit,
    }) =>
      withErrorHandling(
        async () => {
          const projectId = await resolveProjectId(context, p);
          const { startDate, endDate } = resolveDateRange(sd, ed);
          return listEventsCore({
            projectId,
            profileId,
            events,
            startDate,
            endDate,
            limit,
          });
        },
        { tool: 'list_events', context },
      ),
  );

  server.tool(
    'get_sessions',
    "List sessions, newest first — for a whole project or one user (pass profileId). Set onlyReplays to only sessions that have a screen recording. Returns each session's duration, event/screen counts, entry/exit, geo/device.",
    {
      projectId: projectIdSchema(context),
      profileId: z.string().optional().describe('Restrict to one user.'),
      onlyReplays: z
        .boolean()
        .optional()
        .describe('Only sessions that have a replay recording.'),
      ...zDateRange,
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({
      projectId: p,
      profileId,
      onlyReplays,
      startDate: sd,
      endDate: ed,
      limit,
    }) =>
      withErrorHandling(
        async () => {
          const projectId = await resolveProjectId(context, p);
          const { startDate, endDate } = resolveDateRange(sd, ed);
          return getSessionsCore({
            projectId,
            profileId,
            onlyReplays,
            startDate,
            endDate,
            limit,
          });
        },
        { tool: 'get_sessions', context },
      ),
  );

  server.tool(
    'get_profile',
    'Get a user profile by any id (anonymous/device ids resolve to the canonical person). Returns name, email, first-seen, and profile properties, plus the anonymous aliases that map to this person.',
    {
      projectId: projectIdSchema(context),
      id: z.string().describe('A profile id or anonymous/device id.'),
    },
    async ({ projectId: p, id }) =>
      withErrorHandling(
        async () => {
          const projectId = await resolveProjectId(context, p);
          return getProfileCore({ projectId, id });
        },
        { tool: 'get_profile', context },
      ),
  );
}
