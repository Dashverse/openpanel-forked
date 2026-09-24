import { getRetentionCore } from '@openpanel/db';

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

/** Cohort retention — the dashboard "Retention" report, model-sized. */
export function registerRetentionTools(
  server: McpServer,
  context: McpAuthContext,
) {
  server.tool(
    'get_retention',
    'Cohort retention: of the users who first did event A ("firstEvent") in each time bucket, how many came back and did event B ("secondEvent") 0, 1, 2, … buckets later. Returns one row per cohort bucket (oldest first) plus a leading size-weighted-average row; each row has the cohort size (`sum`), the per-bucket returning-user counts (`values`), and those as fractions of the cohort (`percentages`). Users are identity-resolved (anonymous + logged-in activity, and logins across devices, collapse to one person) and anonymous users are included — the same numbers the dashboard Retention chart shows. Use this for "do users stick around", stickiness and churn questions; use get_funnel for one-shot step drop-off.',
    {
      projectId: projectIdSchema(context),
      firstEvent: z
        .array(z.string())
        .min(1)
        .describe(
          'Cohort-defining event name(s), exact + case-sensitive. A user enters a cohort in the bucket they FIRST did any of these (e.g. ["showOpen"]).',
        ),
      secondEvent: z
        .array(z.string())
        .min(1)
        .describe(
          'Return event name(s), exact + case-sensitive. Retention is measured by these firing in later buckets. Pass the same name as firstEvent for classic "came back and did X again" retention.',
        ),
      ...zDateRange,
      interval: z
        .enum(['day', 'week', 'month'])
        .default('day')
        .optional()
        .describe(
          'Cohort bucket size and the unit of "buckets later" (default: day).',
        ),
      criteria: z
        .enum(['on_or_after', 'on'])
        .default('on_or_after')
        .optional()
        .describe(
          '"on_or_after" (default) = a user counts as retained in bucket N if they returned in bucket N or any earlier bucket (classic cumulative retention). "on" = returned exactly in bucket N.',
        ),
      filters: zFilters.describe(
        'Optional property filters (AND-combined) applied to BOTH the cohort-defining (firstEvent) and the return (secondEvent) events — a single global filter, e.g. [{ name: "country", operator: "is", value: ["US"] }].',
      ),
    },
    async ({
      projectId: inputProjectId,
      firstEvent,
      secondEvent,
      startDate: sd,
      endDate: ed,
      interval,
      criteria,
      filters,
    }) =>
      withErrorHandling(
        async () => {
          const projectId = await resolveProjectId(context, inputProjectId);
          const { startDate, endDate } = resolveDateRange(sd, ed);
          return getRetentionCore({
            projectId,
            firstEvent,
            secondEvent,
            startDate,
            endDate,
            interval,
            criteria,
            filters,
          });
        },
        { tool: 'get_retention', context },
      ),
  );
}
