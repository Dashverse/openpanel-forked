import { getActiveUsersCore } from '@openpanel/db';

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

/** Active users (DAU / WAU / MAU) over a range. */
export function registerActiveUsersTools(
  server: McpServer,
  context: McpAuthContext,
) {
  server.tool(
    'get_active_users',
    'Active users per interval over a date range — DAU (interval=day), WAU (week), or MAU (month). Returns the per-bucket count of distinct active users, the range-wide unique total, the average and the peak. An active user is a tracked profile that fired at least one event in the bucket. Optionally include the top events over the range.',
    {
      projectId: projectIdSchema(context),
      ...zDateRange,
      interval: z
        .enum(['day', 'week', 'month'])
        .default('day')
        .optional()
        .describe(
          'Bucket size: "day" = DAU, "week" = WAU, "month" = MAU (default: day).',
        ),
      includeTopEvents: z
        .boolean()
        .optional()
        .describe('Also return the most frequent events over the range.'),
      topEventsLimit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('How many top events to return (default 10, max 50).'),
    },
    async ({
      projectId: inputProjectId,
      startDate: sd,
      endDate: ed,
      interval,
      includeTopEvents,
      topEventsLimit,
    }) =>
      withErrorHandling(
        async () => {
          const projectId = await resolveProjectId(context, inputProjectId);
          const { startDate, endDate } = resolveDateRange(sd, ed);
          return getActiveUsersCore({
            projectId,
            startDate,
            endDate,
            interval,
            includeTopEvents,
            topEventsLimit,
          });
        },
        { tool: 'get_active_users', context },
      ),
  );
}
