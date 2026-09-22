import { getFunnelCore } from '@openpanel/db';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpAuthContext } from '../../auth';
import {
  projectIdSchema,
  resolveDateRange,
  withErrorHandling,
  zDateRange,
  resolveProjectId,
} from '../shared';

export function registerFunnelTools(
  server: McpServer,
  context: McpAuthContext,
) {
  server.tool(
    'get_funnel',
    'Analyze a conversion funnel between 2 or more events. Returns step-by-step conversion rates and drop-off percentages. For example, analyze sign-up flows, checkout funnels, or onboarding sequences.',
    {
      projectId: projectIdSchema(context),
      ...zDateRange,
      steps: z
        .array(z.string())
        .min(2)
        .max(10)
        .describe(
          'Ordered list of event names forming the funnel steps (minimum 2, maximum 10)',
        ),
      windowHours: z
        .number()
        .min(1)
        .max(720)
        .default(24)
        .optional()
        .describe(
          'Time window in hours within which all steps must occur (default: 24 hours)',
        ),
      groupBy: z
        .enum(['session_id', 'profile_id'])
        .default('profile_id')
        .optional()
        .describe(
          'How to count: "profile_id" = unique users across sessions (the default, and what the OpenPanel dashboard uses for its "Profile" funnel group — use this to match a dashboard report); "session_id" = within a single visit.',
        ),
      firstTimeSteps: z
        .array(z.string())
        .optional()
        .describe(
          'Subset of `steps` (event names) to treat as "first time for user": such a step matches only at each user\'s global-first (all-time) occurrence of that event, and only if that first occurrence falls inside the range. Leave empty for the normal funnel.',
        ),
    },
    async ({
      projectId: inputProjectId,
      startDate: sd,
      endDate: ed,
      steps,
      windowHours,
      groupBy,
      firstTimeSteps,
    }) =>
      withErrorHandling(
        async () => {
          const projectId = await resolveProjectId(context, inputProjectId);
          const { startDate, endDate } = resolveDateRange(sd, ed);
          return getFunnelCore({
            projectId,
            startDate,
            endDate,
            steps,
            windowHours,
            groupBy,
            firstTimeSteps,
          });
        },
        { tool: 'get_funnel', context },
      ),
  );
}
