import { getInsightsCore } from '@openpanel/db';

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

/** Time-series insights — the dashboard "insights"/linear chart, model-sized. */
export function registerInsightsTools(
  server: McpServer,
  context: McpAuthContext,
) {
  server.tool(
    'get_insights',
    'Time-series trend for one or more events over a date range — the OpenPanel "insights" chart. Returns a per-interval count for each event (total events, or unique users), optionally split by a breakdown property. Use this for "how many X per day/week/month", trend, and segmentation questions; use get_funnel/get_conversion for step drop-off and A→B rates.',
    {
      projectId: projectIdSchema(context),
      ...zDateRange,
      events: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe('Event names to trend (exact, case-sensitive).'),
      metric: z
        .enum(['count', 'unique'])
        .default('count')
        .optional()
        .describe(
          'What to measure per interval: "count" = total events, "unique" = unique users who did the event.',
        ),
      interval: z
        .enum(['day', 'week', 'month'])
        .default('day')
        .optional()
        .describe('Time bucket for the series (default: day).'),
      breakdown: z
        .string()
        .optional()
        .describe(
          'Optional property to split each event into one series per value. Built-in column: bare name (e.g. "country"); custom property: "properties.<key>". Returns the top values by volume.',
        ),
      filters: zFilters,
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(
          'Max series to return when a breakdown produces many (default 20). Series are ranked by total.',
        ),
    },
    async ({
      projectId: inputProjectId,
      startDate: sd,
      endDate: ed,
      events,
      metric,
      interval,
      breakdown,
      filters,
      limit,
    }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const { startDate, endDate } = resolveDateRange(sd, ed);
        return getInsightsCore({
          projectId,
          startDate,
          endDate,
          events,
          metric,
          interval,
          breakdown,
          filters,
          limit,
        });
      }),
  );
}
