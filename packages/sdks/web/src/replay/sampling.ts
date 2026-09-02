/**
 * Replay sampling decision, taken once per session_id.
 *
 * A per-init roll is wrong on a server-rendered site: this SDK keeps one
 * window_id per tab across full page loads, so a session that rolls again on
 * every load produces one recording with holes in it (page 1 in sample, page 2
 * out, page 3 in again). The decision is therefore persisted next to the
 * session id and reused for as long as that session lives.
 *
 * The stored value is `<sessionId>:1` (recorded) or `<sessionId>:0` (skipped).
 * Scoping it to the session id means a rotation, a corrupt value or a value
 * left behind by an older session all fall through to a fresh roll.
 */

export type ReplaySampleInput = {
  /** Fraction of sessions to record, 0..1. */
  sampleRate: number;
  /** Session the decision applies to. */
  sessionId: string;
  /** Raw value read from storage, or null when there is none. */
  stored: string | null;
  /** A number in [0, 1), normally Math.random(). */
  random: number;
};

export type ReplaySampleDecision = {
  /** Whether this session is in the sample. */
  recorded: boolean;
  /** Value to persist, or null when storage already holds it. */
  store: string | null;
};

export function decideReplaySample({
  sampleRate,
  sessionId,
  stored,
  random,
}: ReplaySampleInput): ReplaySampleDecision {
  const recorded = decideRecorded(sampleRate, sessionId, stored, random);
  const value = `${sessionId}:${recorded ? '1' : '0'}`;

  return { recorded, store: stored === value ? null : value };
}

function decideRecorded(
  sampleRate: number,
  sessionId: string,
  stored: string | null,
  random: number,
): boolean {
  // The ends of the range are absolute: a rate of 1 records every session and
  // a rate of 0 records none, whatever an earlier rate happened to store.
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;

  const previous = readStored(stored, sessionId);
  if (previous !== null) return previous;

  return random < sampleRate;
}

function readStored(stored: string | null, sessionId: string): boolean | null {
  if (stored === null) return null;

  const separator = stored.lastIndexOf(':');
  if (separator === -1) return null;
  if (stored.slice(0, separator) !== sessionId) return null;

  const flag = stored.slice(separator + 1);
  if (flag === '1') return true;
  if (flag === '0') return false;

  return null;
}
