import { getCohortCore, listCohortsCore } from '@openpanel/db';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpAuthContext } from '../../auth';
import {
  projectIdSchema,
  resolveProjectId,
  withErrorHandling,
} from '../shared';

/** Cohort discovery: list a project's cohorts and inspect one. */
export function registerCohortTools(
  server: McpServer,
  context: McpAuthContext,
) {
  server.tool(
    'list_cohorts',
    "List the project's saved cohorts (audiences) — id, name, description, type (event- or property-based), and a cached member count. Use the id with get_cohort to see the definition, or pass it as `cohortId` to get_funnel/get_conversion to gate the analysis to that audience.",
    {
      projectId: projectIdSchema(context),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Max cohorts to return (default 50, max 200).'),
    },
    async ({ projectId: inputProjectId, limit }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        return listCohortsCore({ projectId, limit });
      }),
  );

  server.tool(
    'get_cohort',
    "A single cohort's full definition, a fresh member count, and a small sample of member profile ids. Member ids are canonical persons (a user's anonymous and identified ids collapse to one), matching the identity-resolved profile/funnel/conversion tools.",
    {
      projectId: projectIdSchema(context),
      cohortId: z.string().describe('The cohort id (from list_cohorts).'),
      sampleSize: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe(
          'How many sample member ids to return (default 10, max 100).',
        ),
    },
    async ({ projectId: inputProjectId, cohortId, sampleSize }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        return getCohortCore({ projectId, cohortId, sampleSize });
      }),
  );
}
