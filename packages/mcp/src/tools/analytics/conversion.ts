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
        .min(2)
        .max(10)
        .describe(
          'The events, in order: the first is the starting event, the last is the conversion event (minimum 2).',
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
        .default('session_id')
        .optional()
        .describe(
          '"session_id" counts within-session conversions, "profile_id" counts cross-session conversions (default: session_id).',
        ),
      breakdown: z
        .string()
        .optional()
        .describe(
          'Optional property to break the conversion rate down by. Returns one rate per value. Built-in column: bare name (e.g. "country"); custom property: "properties.<key>" (e.g. "properties.gateway").',
        ),
      filters: zFilters,
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
    }) =>
      withErrorHandling(async () => {
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
        });
      }),
  );
}
