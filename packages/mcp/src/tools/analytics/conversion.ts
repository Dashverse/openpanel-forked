import { getConversionCore } from '@openpanel/db';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpAuthContext } from '../../auth';
import {
  projectIdSchema,
  resolveDateRange,
  resolveProjectId,
  withErrorHandling,
  zDateRange,
  zFilters,
} from '../shared';

export function registerConversionTools(
  server: McpServer,
  context: McpAuthContext,
) {
  server.tool(
    'get_conversion',
    'Measure the conversion rate from one event to another within a time window — e.g. how many users who did "signup" went on to do "purchase". Returns the number who started, the number who converted, and the overall conversion rate. Use this for A→B conversion questions; use get_funnel for multi-step drop-off analysis.',
    {
      projectId: projectIdSchema(context),
      ...zDateRange,
      steps: z
        .array(z.string())
        .length(2)
        .describe(
          'Exactly two events: [startingEvent, conversionEvent]. For multi-step drop-off use get_funnel instead.',
        ),
      windowHours: z
        .number()
        .min(1)
        .max(720)
        .default(24)
        .optional()
        .describe(
          'Time window in hours within which the conversion must happen after the starting event (default: 24 hours).',
        ),
      groupBy: z
        .enum(['session_id', 'profile_id'])
        .default('profile_id')
        .optional()
        .describe(
          'How to count: "profile_id" = unique users across sessions (the default, and what the OpenPanel dashboard uses for its "Profile" funnel group — use this to match a dashboard report); "session_id" = within a single visit.',
        ),
      breakdown: z
        .string()
        .optional()
        .describe(
          'Optional property to break the conversion rate down by. Returns one rate per value. Built-in column: bare name (e.g. "country"); custom property: "properties.<key>" (e.g. "properties.gateway").',
        ),
      filters: zFilters,
      cohortId: z
        .string()
        .optional()
        .describe(
          'Optional cohort id (from list_cohorts) to gate the conversion to that audience — only users in the cohort are counted.',
        ),
      firstTimeSteps: z
        .array(z.string())
        .optional()
        .describe(
          'Subset of `steps` (event names) to treat as "first time for user": the from/to event is gated on each user\'s global-first (all-time) occurrence of it. Leave empty for the normal conversion.',
        ),
    },
    async ({
      projectId: inputProjectId,
      startDate: sd,
      endDate: ed,
      steps,
      windowHours,
      groupBy,
      breakdown,
      filters,
      cohortId,
      firstTimeSteps,
    }) =>
      withErrorHandling(
        async () => {
          const projectId = await resolveProjectId(context, inputProjectId);
          const { startDate, endDate } = resolveDateRange(sd, ed);
          return getConversionCore({
            projectId,
            startDate,
            endDate,
            steps,
            windowHours,
            groupBy,
            breakdown,
            filters,
            cohortId,
            firstTimeSteps,
          });
        },
        { tool: 'get_conversion', context },
      ),
  );
}
