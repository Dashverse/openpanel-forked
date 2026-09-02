import { Readable } from 'node:stream';
import type { ClickHouseSettings, ResponseJSON } from '@clickhouse/client';
import { ClickHouseLogLevel, createClient } from '@clickhouse/client';
import sqlstring from 'sqlstring';

import type { NodeClickHouseClientConfigOptions } from '@clickhouse/client/dist/config';
import { createLogger } from '@openpanel/logger';
import {
  currentSpanId,
  currentTraceId,
  getQueryContext,
  withSpan,
} from '@openpanel/telemetry';
import type { IInterval } from '@openpanel/validation';

export { createClient };

const logger = createLogger({ name: 'clickhouse' });

import type { Logger } from '@clickhouse/client';
import { getSafeJson } from '@openpanel/json';

// All three LogParams types are exported by the client
interface LogParams {
  module: string;
  message: string;
  args?: Record<string, unknown>;
}
type ErrorLogParams = LogParams & { err: Error };
type WarnLogParams = LogParams & { err?: Error };

class CustomLogger implements Logger {
  trace({ message, args }: LogParams) {
    logger.debug(message, args);
  }
  debug({ message, args }: LogParams) {
    if (message.includes('Query:') && args?.response_status === 200) {
      return;
    }
    logger.debug(message, args);
  }
  info({ message, args }: LogParams) {
    logger.info(message, args);
  }
  warn({ message, args }: WarnLogParams) {
    logger.warn(message, args);
  }
  error({ message, args, err }: ErrorLogParams) {
    logger.error(message, {
      ...args,
      error: err,
    });
  }
}

export const TABLE_NAMES = {
  events: 'events',
  events_v2: 'events_v2',
  events_daily_stats: 'events_daily_stats',
  profiles: 'profiles',
  alias: 'profile_aliases',
  self_hosting: 'self_hosting',
  events_bots: 'events_bots',
  dau_mv: 'dau_mv',
  event_names_mv: 'distinct_event_names_mv',
  event_property_values_mv: 'event_property_values_mv',
  cohort_events_mv: 'cohort_events_mv',
  sessions: 'sessions',
  events_imports: 'events_imports_v2',
  cohort_members: 'cohort_members',
  cohort_metadata: 'cohort_metadata',
  profile_event_summary_mv: 'profile_event_summary_mv',
  session_replay_chunks: 'session_replay_chunks',
};

/**
 * Route analytics reads to `events_v2` (the name-first sort-key table) when the
 * query's range is fully inside the window events_v2 is known to hold complete.
 *
 * events_v2 is fed live by the `events_to_v2` dual-write MV from T0 forward and
 * backfilled day-by-day before T0. So it is complete only from a moving boundary
 * — `EVENTS_V2_MIN_DATE` — which we lower as backfill verifies older days.
 *
 * Gated OFF by default (`EVENTS_V2_ENABLED`): zero behavior change until set.
 * A query whose `startDate` is before the boundary (or missing) stays on `events`,
 * so we never serve a range events_v2 doesn't fully cover. Conservative on purpose.
 *
 * `startDate` / `EVENTS_V2_MIN_DATE` are 'YYYY-MM-DD[ HH:MM:SS]' strings — a
 * lexicographic compare is chronological for that fixed format.
 */
export function getEventsTableForRange(startDate?: string | null): string {
  const enabled =
    process.env.EVENTS_V2_ENABLED === '1' ||
    process.env.EVENTS_V2_ENABLED === 'true';
  if (!enabled) return TABLE_NAMES.events;

  const minDate = process.env.EVENTS_V2_MIN_DATE?.trim();
  const table =
    minDate && startDate && String(startDate) >= minDate
      ? TABLE_NAMES.events_v2
      : TABLE_NAMES.events;

  // Visible routing decision (only logs when routing is enabled). Grep the dev
  // process output for `[events-routing]` to see events vs events_v2 per query.
  logger.info(`[events-routing] -> ${table}`, { table, startDate, minDate });
  return table;
}

/**
 * Anon→canonical identity resolution.
 *
 * `PROFILE_ALIAS_DICT` = the name of a ClickHouse DICTIONARY (e.g.
 * `default.profile_alias_dict`, keyed by (project_id, alias) -> canonical) that
 * resolves a device/anon profile_id to its identified user id via an in-RAM
 * dictGet — replacing the per-query `al` CTE that scans the whole profile_aliases
 * table (~33.7M rows) twice. Measured: 5.3s -> 0.38s on a breakdown funnel.
 *
 * Gated OFF by default: when the env var is unset (dev / self-hosted / any env
 * without the dict) callers fall back to the `al` CTE + JOIN, byte-identical to
 * before. Only prod (which has the dict loaded on every replica) sets it.
 */
export function getProfileAliasDict(): string | undefined {
  const name = process.env.PROFILE_ALIAS_DICT?.trim();
  return name && name.length > 0 ? name : undefined;
}

/**
 * SQL expression resolving an id to its canonical.
 * - `lookupKey`: the raw id looked up in the alias map (a qualified column, e.g.
 *   `events.profile_id`). This MUST be the same column the `al` CTE joins on.
 * - `fallback` (default = lookupKey): the value used when `lookupKey` has no
 *   alias. In funnel this is the session-stitched id (COALESCE(s.pid, ...)); in
 *   conversion it is just `lookupKey` itself.
 *
 * Both modes have identical semantics — "canonical(lookupKey) if aliased, else
 * fallback":
 * - dict on  -> coalesce(nullIf(dictGet(lookupKey), ''), fallback) (no CTE/JOIN)
 * - dict off -> coalesce(nullIf(al.canonical, ''), fallback) (caller emits the
 *   `al` CTE + `LEFT JOIN al ON al.alias = lookupKey`; see aliasResolutionNeedsCte).
 *
 * The dict name + projectId are escaped (they never reach SQL raw).
 */
export function resolvedProfileIdSql(
  projectId: string,
  lookupKey: string,
  fallback: string = lookupKey,
): string {
  const dict = getProfileAliasDict();
  // Visible resolution path. Grep the dev process output for `[alias-resolution]`.
  logger.info(
    `[alias-resolution] -> ${dict ? `dictGet(${dict})` : 'al-cte (profile_aliases scan)'}`,
  );
  if (dict) {
    return `coalesce(nullIf(dictGetOrDefault(${sqlstring.escape(dict)}, 'canonical', (${sqlstring.escape(projectId)}, ${lookupKey}), ''), ''), ${fallback})`;
  }
  return `coalesce(nullIf(al.canonical, ''), ${fallback})`;
}

/**
 * Resolve an event to its canonical person id — the ONE resolver funnels /
 * conversions / charts should use.
 *
 * `profile_aliases` is keyed on `$device_id` (= the `device_id` column), NOT the
 * anon `distinct_id` that the mixpanel-proxy lands in `profile_id`. Frameo's
 * device-id sync made `distinct_id != $device_id`, so looking up the alias on
 * `profile_id` misses and drops conversions. This looks up the alias on
 * `deviceIdKey` and falls back to `profileIdKey` — a no-op where they're equal
 * (native / single-SDK projects), a fix where they differ (frameo split).
 *
 * The matching `al` CTE (dict off) MUST join on the same `deviceIdKey`.
 */
export function resolvedPersonIdSql(
  projectId: string,
  deviceIdKey: string,
  profileIdKey: string,
): string {
  return resolvedProfileIdSql(projectId, deviceIdKey, profileIdKey);
}

/** True when the caller still needs to emit the `al` CTE + `LEFT JOIN al` (dict off). */
export function aliasResolutionNeedsCte(): boolean {
  return !getProfileAliasDict();
}

/**
 * Check if ClickHouse is running in clustered mode
 * Clustered mode = production (not self-hosted)
 * Non-clustered mode = self-hosted environments
 */
export function isClickhouseClustered(): boolean {
  return !(
    process.env.SELF_HOSTED === 'true' || process.env.SELF_HOSTED === '1'
  );
}

/**
 * Get the replicated table name for mutations
 * In clustered mode, returns table_name_replicated
 * In non-clustered mode, returns the original table name
 */
export function getReplicatedTableName(tableName: string): string {
  if (isClickhouseClustered()) {
    return `${tableName}_replicated ON CLUSTER '{cluster}'`;
  }
  return tableName;
}

function getClickhouseSettings(): ClickHouseSettings {
  const additionalSettings =
    getSafeJson<ClickHouseSettings>(process.env.CLICKHOUSE_SETTINGS || '{}') ||
    {};

  // Per-user concurrent SELECT limit for the app's CH user. A dashboard full of
  // report widgets fans out to many parallel chart/funnel queries on a cold load
  // (and when the "Reload" button bypasses the Redis cache); CH's default of 10
  // rejects the excess with "Too many simultaneous queries". Set this in prod to
  // give that burst headroom. Unset = leave CH's own default untouched.
  // (Inserts and profile reads set their own higher limits per-query.)
  // Passed as a string — that's the @clickhouse/client setting type, and CH
  // receives all HTTP settings as strings. Validate it's numeric so a bad value
  // is ignored rather than sent to CH.
  const rawQueryLimit = process.env.CLICKHOUSE_QUERY_LIMIT?.trim();
  const queryLimit =
    rawQueryLimit && Number.isFinite(Number(rawQueryLimit))
      ? rawQueryLimit
      : undefined;

  return {
    date_time_input_format: 'best_effort',
    ...(queryLimit ? { max_concurrent_queries_for_user: queryLimit } : {}),
    ...(!process.env.CLICKHOUSE_SETTINGS_REMOVE_CONVERT_ANY_JOIN
      ? {
          query_plan_convert_any_join_to_semi_or_anti_join: 0,
        }
      : {}),
    ...additionalSettings,
  };
}

export const CLICKHOUSE_OPTIONS: NodeClickHouseClientConfigOptions = {
  max_open_connections: 30,
  request_timeout: Number.parseInt(
    process.env.CLICKHOUSE_REQUEST_TIMEOUT || '3600000',
    10,
  ),
  keep_alive: {
    enabled: true,
    // Must be lower than server-side keep_alive_timeout (CH default 10s)
    // so we never reuse a socket the server has already closed.
    // Matches upstream openpanel — kept that value rather than going
    // more aggressive because upstream's been running it in production
    // long enough to validate it.
    //
    // The previous 60s value here was guaranteed to hit stale sockets
    // under sustained load: server closes after ~10s idle, client kept
    // the socket in the pool until 60s, and the next reuse failed with
    // "socket hang up" / ECONNRESET. Worker-cron logs showed ~70 hang
    // ups per 15min at 100% replay sampling before this change.
    idle_socket_ttl: 7000,
  },
  compression: {
    request: true,
  },
  clickhouse_settings: getClickhouseSettings(),
  log: {
    LoggerClass: CustomLogger,
    level: ClickHouseLogLevel.DEBUG,
  },
  // Custom JSON serializer used on inserts. For buffers that already
  // hold JSONEachRow lines as strings (event/replay/bot/group — pulled
  // straight out of Redis), this is a passthrough — no JSON.stringify
  // on the hot path. For buffers that pass real objects (session /
  // profile, which need to parse + transform before inserting), it
  // falls back to JSON.stringify. The client appends '\n' itself.
  json: {
    stringify: <T>(value: T): string =>
      typeof value === 'string' ? value : JSON.stringify(value),
  },
};

logger.info('Clickhouse options', CLICKHOUSE_OPTIONS);

export const originalCh = createClient({
  url: process.env.CLICKHOUSE_URL,
  ...CLICKHOUSE_OPTIONS,
});

const cleanQuery = (query?: string) =>
  typeof query === 'string'
    ? query.replace(/\n/g, '').replace(/\s+/g, ' ').trim()
    : undefined;

export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 5,
  baseDelay = 500,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await operation();
      if (attempt > 0) {
        logger.info('Retry operation succeeded', { attempt });
      }
      return res;
    } catch (error: any) {
      lastError = error;

      if (
        error.message.includes('Connect') ||
        error.message.includes('socket hang up') ||
        error.message.includes('Timeout error')
      ) {
        const delay = baseDelay * 2 ** attempt;
        logger.warn(
          `Attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delay}ms`,
          {
            error: error.message,
          },
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw error; // Non-retriable error
    }
  }

  throw lastError;
}

// Truncate long SQL for span attributes — the whole point is a searchable
// snippet, not the full payload. Bodies often carry PII in WHERE clauses,
// so we cap aggressively; the trace_id + CH log_comment (below) is the
// canonical join key to the full query in system.query_log.
const MAX_SPAN_STATEMENT_LEN = 500;

function truncateStatement(sql: unknown): string | undefined {
  if (typeof sql !== 'string') return undefined;
  const collapsed = sql.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_SPAN_STATEMENT_LEN
    ? `${collapsed.slice(0, MAX_SPAN_STATEMENT_LEN)}…`
    : collapsed;
}

// Build a JSON log_comment stamping the current trace + query context on
// every CH query. Fields come from two places: OTel (trace_id, span_id)
// and the OpenPanel request-scoped query context (project_id, endpoint,
// chart_type, user_id, organization_id) — set by tRPC middleware and by
// the /track controllers, and inherited automatically by any CH query
// fired downstream. avnadmin's scrape of system.query_log lands these in
// SigNoz where every field is a one-click filter — no join to spans
// needed for "which project cost the most CH memory today" or "which
// chart type has the slowest queries".
//
// Emits log_comment as long as EITHER there is an active trace OR the
// request stamped something into query context; skips when both are
// empty so log_comment stays absent for background code paths that
// haven't been enriched (matches prior behaviour).
//
// Example lookup once queries land in system.query_log:
//
//   SELECT query, query_duration_ms, memory_usage, rows_read, exception
//   FROM system.query_log
//   WHERE JSONExtractString(log_comment, 'project_id') = 'proj_xxx'
//     AND type = 'QueryFinish'
//   ORDER BY query_duration_ms DESC
//   LIMIT 10;
function buildLogComment(): string | undefined {
  const traceId = currentTraceId();
  const qc = getQueryContext();
  const hasQueryContext =
    !!qc.project_id ||
    !!qc.endpoint ||
    !!qc.chart_type ||
    !!qc.user_id;
  if (!traceId && !hasQueryContext) return undefined;

  // Assemble by hand — JSON.stringify would emit "undefined" for missing
  // values on some fields; explicit object keeps the payload compact.
  const payload: Record<string, string> = {
    service: process.env.OTEL_SERVICE_NAME ?? 'openpanel-unknown',
  };
  if (traceId) payload.trace_id = traceId;
  const spanId = currentSpanId();
  if (spanId) payload.span_id = spanId;
  if (qc.project_id) payload.project_id = qc.project_id;
  if (qc.endpoint) payload.endpoint = qc.endpoint;
  if (qc.chart_type) payload.chart_type = qc.chart_type;
  if (qc.user_id) payload.user_id = qc.user_id;
  return JSON.stringify(payload);
}

export const ch = new Proxy(originalCh, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);

    if (property === 'insert') {
      return (...args: any[]) =>
        withSpan(
          'ch.insert',
          {
            attributes: {
              'db.system': 'clickhouse',
              'db.operation': 'insert',
              'db.clickhouse.table': args[0]?.table ?? 'unknown',
              'db.clickhouse.format': args[0]?.format ?? 'JSONEachRow',
            },
          },
          () =>
            withRetry(() => {
              const logComment = buildLogComment();
              args[0].clickhouse_settings = {
                // Increase insert timeouts and buffer sizes for large batches
                max_execution_time: 300,
                max_insert_block_size: '500000',
                max_http_get_redirects: '0',
                // Ensure JSONEachRow stays efficient
                input_format_parallel_parsing: 1,
                // Keep long-running inserts/queries from idling out at proxies by sending progress headers
                send_progress_in_http_headers: 1,
                http_headers_progress_interval_ms: '50000',
                // Ensure server holds the connection until the query is finished
                wait_end_of_query: 1,
                // Remove concurrent query limit for INSERT operations to prevent blocking
                // when multiple buffers flush simultaneously
                max_concurrent_queries_for_user: Number.parseInt(
                  process.env.CLICKHOUSE_INSERT_QUERY_LIMIT || '50',
                  10,
                ),
                // Stamp the active trace so system.query_log can be joined
                // back to spans via log_comment. Caller can still override
                // by setting their own log_comment in clickhouse_settings.
                ...(logComment ? { log_comment: logComment } : {}),
                ...args[0].clickhouse_settings,
              };
              return value.apply(target, args);
            }),
        );
    }

    if (property === 'query') {
      return (...args: any[]) =>
        withSpan(
          'ch.query',
          {
            attributes: {
              'db.system': 'clickhouse',
              'db.operation': 'query',
              'db.statement': truncateStatement(args[0]?.query),
            },
          },
          () =>
            withRetry(() => {
              const logComment = buildLogComment();
              if (logComment && args[0]) {
                args[0].clickhouse_settings = {
                  log_comment: logComment,
                  ...args[0].clickhouse_settings,
                };
              }
              return value.apply(target, args);
            }),
        );
    }

    if (property === 'command') {
      return (...args: any[]) =>
        withSpan(
          'ch.command',
          {
            attributes: {
              'db.system': 'clickhouse',
              'db.operation': 'command',
              'db.statement': truncateStatement(args[0]?.query),
            },
          },
          () =>
            withRetry(() => {
              const logComment = buildLogComment();
              if (logComment && args[0]) {
                args[0].clickhouse_settings = {
                  log_comment: logComment,
                  ...args[0].clickhouse_settings,
                };
              }
              return value.apply(target, args);
            }),
        );
    }

    return value;
  },
});

export async function chQueryWithMeta<T extends Record<string, any>>(
  query: string,
  clickhouseSettings?: ClickHouseSettings,
  bypassConcurrencyLimit = false,
): Promise<ResponseJSON<T>> {
  const start = Date.now();

  // Merge settings, allowing higher concurrent query limit for critical operations
  // to prevent profile queries from being blocked by dashboard query limits
  const finalSettings = bypassConcurrencyLimit
    ? {
        ...clickhouseSettings,
        max_concurrent_queries_for_user: Number.parseInt(
          process.env.CLICKHOUSE_PROFILE_QUERY_LIMIT || '50',
          10,
        ),
      }
    : clickhouseSettings;

  const res = await ch.query({
    query,
    clickhouse_settings: finalSettings,
  });
  const json = await res.json<T>();
  const keys = Object.keys(json.data[0] || {});
  const response = {
    ...json,
    data: json.data.map((item) => {
      return keys.reduce((acc, key) => {
        const meta = json.meta?.find((m) => m.name === key);
        return {
          ...acc,
          [key]:
            item[key] && meta?.type.includes('Int')
              ? Number.parseFloat(item[key] as string)
              : item[key],
        };
      }, {} as T);
    }),
  };

  logger.info('query info', {
    query: cleanQuery(query),
    rows: json.rows,
    stats: response.statistics,
    elapsed: Date.now() - start,
    clickhouseSettings,
  });

  return response;
}

export async function chInsertCSV(tableName: string, rows: string[]) {
  try {
    const now = performance.now();
    const chunkSize = Number.parseInt(
      process.env.IMPORT_CSV_CHUNK_SIZE || '10000',
      10,
    );

    // Insert in chunks to reduce memory pressure
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const csvStream = Readable.from(chunk.join('\n'), {
        objectMode: false,
      });

      await ch.insert({
        table: tableName,
        values: csvStream,
        format: 'CSV',
        clickhouse_settings: {
          format_csv_allow_double_quotes: 1,
          format_csv_allow_single_quotes: 0,
        },
      });
    }

    logger.info('CSV Insert successful', {
      elapsed: performance.now() - now,
      rows: rows.length,
      chunks: Math.ceil(rows.length / chunkSize),
    });
  } catch (error) {
    logger.error('CSV Insert failed:', error);
    throw error;
  }
}

export async function chQuery<T extends Record<string, any>>(
  query: string,
  clickhouseSettings?: ClickHouseSettings,
  bypassConcurrencyLimit = false,
): Promise<T[]> {
  return (
    await chQueryWithMeta<T>(query, clickhouseSettings, bypassConcurrencyLimit)
  ).data;
}

export function formatClickhouseDate(
  date: Date | string,
  skipTime = false,
): string {
  if (skipTime) {
    return new Date(date).toISOString().split('T')[0]!;
  }
  return new Date(date)
    .toISOString()
    .replace('T', ' ')
    .replace(/(\.\d{3})?Z+$/, '');
}

export function toDate(str: string, interval?: IInterval) {
  // If it does not match the regex it's a column name eg 'created_at'
  if (!interval || interval === 'minute' || interval === 'hour') {
    if (str.match(/\d{4}-\d{2}-\d{2}/)) {
      return sqlstring.escape(str);
    }

    return str;
  }

  if (str.match(/\d{4}-\d{2}-\d{2}/)) {
    return `toDate(${sqlstring.escape(str.split(' ')[0])})`;
  }

  return `toDate(${str})`;
}

export function convertClickhouseDateToJs(date: string) {
  return new Date(`${date.replace(' ', 'T')}Z`);
}
