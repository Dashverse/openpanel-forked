import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpAuthContext } from '../auth';
import { registerActiveUsersTools } from './analytics/active-users';
import { registerCohortTools } from './analytics/cohorts';
import { registerConversionTools } from './analytics/conversion';
import { registerDiscoveryTools } from './analytics/discovery';
import { registerFunnelTools } from './analytics/funnel';
import { registerIdentityTools } from './analytics/identity';
import { registerInsightsTools } from './analytics/insights';
import { registerReplayTools } from './analytics/replay';
import { registerUserTools } from './analytics/user';

/**
 * Tools are added one at a time as each `*Core` seam is re-homed onto the
 * fork's services and validated against the dashboard.
 */
export function registerAllTools(
  server: McpServer,
  context: McpAuthContext,
): void {
  // Discovery first — agents call these to get exact names/keys/values.
  registerDiscoveryTools(server, context);
  // Trends & audiences
  registerInsightsTools(server, context);
  registerActiveUsersTools(server, context);
  registerCohortTools(server, context);
  // Behaviour
  registerFunnelTools(server, context);
  registerConversionTools(server, context);
  // Identity (fork differentiator)
  registerIdentityTools(server, context);
  // User-centric: profile, events, sessions, unified journey
  registerUserTools(server, context);
  // Session replay links
  registerReplayTools(server, context);
}
