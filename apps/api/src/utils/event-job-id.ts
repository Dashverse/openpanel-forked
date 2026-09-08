import { v5 as uuidv5 } from 'uuid';

// Fixed namespace so the deterministic hash is stable across processes and
// deploys. Any constant UUID works — it only salts the hash so these ids don't
// collide with other uuidv5 uses.
const EVENT_JOB_ID_NAMESPACE = '1b671a64-40d5-491e-99b0-da01ff1f3341';

/**
 * Deterministic dedup job-id for an incoming event.
 *
 * The same event (same name, timestamp, project, device and group) always
 * hashes to the same id, so GroupMQ deduplicates a retried enqueue exactly as
 * before. We hash the composite instead of using the raw
 * `name-timestamp-device-…` concatenation so the job-id is a uniform,
 * fixed-length, PII-free key rather than a variable-length string that embeds
 * device/profile ids.
 */
export function buildEventJobId(
  parts: Array<string | number | undefined | null>,
): string {
  return uuidv5(parts.filter(Boolean).join('-'), EVENT_JOB_ID_NAMESPACE);
}
