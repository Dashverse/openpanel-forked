import {
  getEventNamesCore,
  getEventPropertiesCore,
  getPropertyValuesCore,
} from '@openpanel/db';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpAuthContext } from '../../auth';
import { projectIdSchema, resolveProjectId, withErrorHandling } from '../shared';

/**
 * Discovery tools — let the agent find the EXACT (case-sensitive) event names,
 * property keys, and values before calling funnel/conversion/etc. All fast
 * (name-scoped / catalog reads).
 */
export function registerDiscoveryTools(
  server: McpServer,
  context: McpAuthContext,
) {
  server.tool(
    'get_event_names',
    'List the event names for a project, most frequent first. Call this first to get exact, case-sensitive event names (e.g. "show1Activated", not "show1activated") before using get_funnel/get_conversion. Optionally filter by a substring.',
    {
      projectId: projectIdSchema(context),
      search: z
        .string()
        .optional()
        .describe('Case-insensitive substring to filter event names by.'),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    async ({ projectId: p, search, limit }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, p);
        return getEventNamesCore({ projectId, search, limit });
      }),
  );

  server.tool(
    'get_event_properties',
    'List the property keys available on a specific event (e.g. what you can filter or break down by for "paymentInitiate"). Returns each key with how many distinct values it has. Use the returned `property` string (e.g. "properties.gateway") in get_funnel/get_conversion filters and breakdowns.',
    {
      projectId: projectIdSchema(context),
      eventName: z
        .string()
        .describe('Exact event name (from get_event_names).'),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    async ({ projectId: p, eventName, limit }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, p);
        return getEventPropertiesCore({ projectId, eventName, limit });
      }),
  );

  server.tool(
    'get_property_values',
    'List the distinct values seen for a property on a specific event (e.g. the gateways in "paymentInitiate".properties.gateway). Use before filtering so you match real values exactly.',
    {
      projectId: projectIdSchema(context),
      eventName: z.string().describe('Exact event name.'),
      property: z
        .string()
        .describe('Property, e.g. "gateway" or "properties.gateway".'),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    async ({ projectId: p, eventName, property, limit }) =>
      withErrorHandling(async () => {
        const projectId = await resolveProjectId(context, p);
        return getPropertyValuesCore({ projectId, eventName, property, limit });
      }),
  );
}
