// Transport "parts" for session-replay chunks whose compressed value is over the
// per-message limit (Event Hubs Standard: 1 MB per message AND per produce
// request). The producer splits the COMPRESSED bytes into parts and the worker
// joins them back before decompressing, so a fat full snapshot (one rrweb
// event, can't be split at the event level) still reaches storage.
//
// Wire format: each part is a normal replay message on the same key
// (sessionId) with these headers; a value under the limit is sent as ONE
// message with none of them (unchanged, so old consumers keep working):
//   x-replay-chunk-id  random uuid per produce attempt (an SDK retry of the
//                      same chunk gets a new id; readers de-dup by chunk)
//   x-replay-part      0-based part index
//   x-replay-parts     part count (>= 2)
// Every part also carries the chunk's content-encoding (lz4 | zstd), which
// describes the JOINED bytes: a single part is not a decodable frame.
//
// Dependency-free on purpose: the worker's reassembly (and its unit tests)
// import these without pulling in Kafka, Redis or BullMQ.

export const REPLAY_CHUNK_ID_HEADER = 'x-replay-chunk-id';
export const REPLAY_PART_HEADER = 'x-replay-part';
export const REPLAY_PARTS_HEADER = 'x-replay-parts';

// Hard cap on the declared part count, enforced by BOTH sides (the producer
// returns 'oversize' above it, the consumer drops a set that declares more).
// The default total cap (~3.3 MB, from the 5 MiB fetch) is 4 parts of 950 KB,
// so 32 leaves room to tune the byte caps without touching this.
export const REPLAY_KAFKA_MAX_PARTS = Number.parseInt(
  process.env.REPLAY_KAFKA_MAX_PARTS || '32',
  10,
);

/** Split `value` into consecutive slices of at most `maxPartBytes` (views, no copy). */
export function splitReplayValue(
  value: Uint8Array,
  maxPartBytes: number,
): Buffer[] {
  if (!(maxPartBytes > 0)) {
    throw new Error(`invalid replay part size: ${maxPartBytes}`);
  }
  const buf = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += maxPartBytes) {
    parts.push(buf.subarray(i, i + maxPartBytes));
  }
  return parts;
}

/** Reverse `splitReplayValue`: parts must be in index order. */
export function joinReplayParts(parts: Uint8Array[]): Buffer {
  return Buffer.concat(parts);
}
