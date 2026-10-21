import { parseReplayTimestampMs } from './replay-block.service';

/**
 * Validation of an SDK replay chunk's scalar fields at ingest (/track).
 *
 * /track only checks that `payload` is an object, so before this a chunk with
 * a numeric or missing `started_at` reached Kafka, where the block writer's
 * sort threw on it: on a Blob-only project that failed the batch on every
 * redelivery and stalled the partition. Timestamps are normalised to ISO-8601
 * UTC (what the web SDK already sends), so every reader can compare them as
 * strings and ClickHouse parses them the same way.
 */

export interface ReplayChunkFields {
  chunk_index: number;
  started_at: string;
  ended_at: string;
  events_count: number;
  is_full_snapshot: boolean;
  payload: string;
}

const UINT16_MAX = 65_535;

// Same parsing as the worker and readers (parseReplayTimestampMs): ISO and
// ClickHouse datetime strings, and epoch numbers or numeric strings in
// seconds or milliseconds.
function toIso(v: unknown): string | null {
  const ms = parseReplayTimestampMs(v);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const isUInt16 = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= UINT16_MAX;

/** The normalised fields, or the reason the chunk is rejected (→ 400). */
export function normalizeReplayChunkFields(
  input: Record<string, unknown>,
): { ok: true; fields: ReplayChunkFields } | { ok: false; error: string } {
  if (!isUInt16(input.chunk_index)) {
    return { ok: false, error: 'chunk_index must be an integer 0-65535' };
  }
  const startedAt = toIso(input.started_at);
  if (!startedAt) {
    return { ok: false, error: 'started_at must be a valid timestamp' };
  }
  // A missing/invalid ended_at is not worth rejecting the chunk for: it only
  // feeds durations, and the chunk can't end before it started.
  const endedAt = toIso(input.ended_at) ?? startedAt;
  if (typeof input.payload !== 'string') {
    return { ok: false, error: 'payload must be a string' };
  }
  // events_count is UInt16 in CH; missing → 0 (what JSONEachRow did), and an
  // out-of-range count is clamped rather than failing the insert.
  const events =
    typeof input.events_count === 'number' &&
    Number.isFinite(input.events_count)
      ? Math.min(UINT16_MAX, Math.max(0, Math.floor(input.events_count)))
      : 0;
  return {
    ok: true,
    fields: {
      chunk_index: input.chunk_index,
      started_at: startedAt,
      ended_at: endedAt < startedAt ? startedAt : endedAt,
      events_count: events,
      is_full_snapshot:
        input.is_full_snapshot === true || input.is_full_snapshot === 1,
      payload: input.payload,
    },
  };
}
