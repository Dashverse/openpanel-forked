// Pure helpers for the Kafka consumer's retry-dedup (see events.kafka-consumer).
// Kept side-effect-free (no metrics/redis imports) so they can be unit-tested
// without booting the consumer module.

// A dedup key is only trustworthy if the client `$insert_id` is a real UUID with
// a valid version nibble (1-8). Requiring [1-8] in the version position rejects
// BOTH the nil UUID (00000000-0000-0000-0000-000000000000, version 0) and the
// max UUID (ffffffff-…-ffffffffffff, version f) — the classic "unset default"
// values a client library emits when it fails to generate one. Either would
// otherwise collapse a whole project's events into a single dedup key for the
// TTL window (silent data loss). A weak / non-UUID value falls back to the
// server jobId instead.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_DEDUP_TTL_SECONDS = 21600; // 6h

/**
 * Whether a client-supplied `$insert_id` is trustworthy enough to dedup on.
 * Only a syntactically valid, versioned (v1–v8) UUID qualifies; nil / max / weak
 * values do not — deduping on those would drop genuinely-distinct events.
 */
export function isDedupableInsertId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * The dedup id for an event: the client `$insert_id` when it is a real UUID,
 * else the server-computed jobId. Returns undefined when neither is usable — the
 * caller then skips dedup for that event (we never DROP on an absent key).
 */
export function resolveDedupId(
  insertId: unknown,
  jobId: string | undefined,
): string | undefined {
  return isDedupableInsertId(insertId) ? insertId : jobId;
}

/**
 * Parse KAFKA_DEDUP_TTL_SECONDS. Number() (not parseInt) so a fat-fingered "6h"
 * becomes NaN and falls back to the default rather than silently parsing to a
 * 6-SECOND window; NaN / 0 / "" all fall back too.
 */
export function parseDedupTtlSeconds(
  raw: string | undefined,
  fallback = DEFAULT_DEDUP_TTL_SECONDS,
): number {
  return Number(raw) || fallback;
}
