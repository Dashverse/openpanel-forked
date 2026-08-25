// Query context — piggybacks on OTel's context API so any code running
// inside a request/job automatically sees the enrichment when it fires a
// ClickHouse query. Read by buildLogComment in packages/db so every CH
// query's log_comment carries who/what/where triggered it. avnadmin
// scrapes system.query_log into SigNoz where every field becomes a
// one-click filter — "which project cost the most CH memory today",
// "which chart type has the slowest queries", "which user is burning
// the most rows_read" — all without needing to join back to spans.
//
// This is the pattern PostHog uses for their internal query attribution
// (posthog/clickhouse/query_tagging.py): stamp everything you want to
// filter by INTO the log_comment JSON, at the layer that knows it
// (middleware / hook / handler), let it flow through async context to
// the DB layer, and read it back at query time.

import { context, createContextKey } from '@opentelemetry/api';

// Every field is optional so any caller can stamp only what it knows —
// tRPC middleware knows all three for a dashboard query, but the /track
// controller only knows project_id (no user, no chart, no endpoint
// beyond the route). buildLogComment omits missing fields from the JSON.
//
// organization_id intentionally omitted for now: single-tenant deployment,
// all projects under one org, so the field would always be a constant
// value in log_comment with zero filter value. Trivial to add back
// (interface field + tRPC middleware line + buildLogComment line) if we
// ever go multi-tenant.
export interface QueryContextAttrs {
  project_id?: string;
  endpoint?: string;
  chart_type?: string;
  user_id?: string;
}

const KEY = createContextKey('openpanel.query-context');

export function getQueryContext(): QueryContextAttrs {
  return (context.active().getValue(KEY) as QueryContextAttrs) ?? {};
}

// Runs `fn` with the given attrs merged onto the current query context.
// Merge semantics — later stamps override earlier ones; missing fields
// preserve what was already there. So an outer HTTP hook can stamp
// project_id, and an inner tRPC middleware can add chart_type on top
// without wiping the project_id.
export function withQueryContext<T>(
  attrs: QueryContextAttrs,
  fn: () => T,
): T {
  const existing = getQueryContext();
  const merged: QueryContextAttrs = { ...existing, ...attrs };
  return context.with(context.active().setValue(KEY, merged), fn);
}
