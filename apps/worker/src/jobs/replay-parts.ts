import type { ReplayLineWithOffset } from '@openpanel/db';
import {
  REPLAY_CHUNK_ID_HEADER,
  REPLAY_PARTS_HEADER,
  REPLAY_PART_HEADER,
  joinReplayParts,
} from '@openpanel/queue/src/replay-parts';

/**
 * One Kafka replay batch (one partition, offset-ordered) → the JSONEachRow
 * lines to write + the highest offset that is safe to resolve.
 *
 * A message without part headers is a whole chunk (unchanged legacy path). A
 * chunk over the per-message limit arrives as parts (packages/queue/src/
 * replay-parts.ts): same key, so the same partition, in index order (the
 * producer awaits each part's ack), but NOT contiguous (other sessions'
 * messages interleave). Rules:
 *
 *  complete    all indexes 0..n-1 present → joined in index order, decoded
 *              once, written at the offset of its first part (block_index).
 *  incomplete  part 0 present, some part missing, not abandoned. The batch is
 *              CUT at its first part: messages before it are written and
 *              resolved, nothing from it on is touched, so Kafka redelivers
 *              from there and the next batch holds the whole set again.
 *              Stopping (instead of writing past it and accepting a duplicate
 *              on redelivery) means nothing is written twice on the happy
 *              path. A complete set that STARTS before the cut is written even
 *              if its last part lies past it; that trailing part comes back as
 *              a leftover (below).
 *  leftover    parts whose part 0 is not in the batch: part 0 sits before the
 *              batch start, i.e. was already resolved (its set written or
 *              dropped), since part i is only produced after part i-1 is
 *              stored. Skipped silently.
 *  invalid     bad/inconsistent headers (index or count not an integer, count
 *              < 2 or > maxParts, index >= count, counts disagree within the
 *              chunk id) → the set is dropped. It can never be joined.
 *  abandoned   incomplete, and the batch holds a message after its first part
 *              that was produced >= abandonAfterMs after it. The producer
 *              gives up on a set well within that window (parts deadline +
 *              one send's retries), so the missing parts will never come
 *              (send failed mid-way, pod died) → dropped.
 *  unfetchable incomplete at the HEAD of a batch that is not at the partition
 *              tail and whose bytes already reached the per-partition fetch
 *              limit (within one message: the broker stops when the next
 *              record batch would not fit): a refetch from the same offset
 *              returns the same messages, so it can never complete →
 *              dropped. The producer caps a set at the fetch size minus two
 *              messages, so this only happens when more than that was
 *              interleaved between its parts. A smaller batch that is not at
 *              the tail (the whole-fetch maxBytes was shared with other
 *              partitions) just waits for a fuller refetch. A head blocked
 *              for longer than maxHeadBlockedMs without reaching the tail is
 *              also dropped (last resort against a broker returning less per
 *              fetch than asked).
 *
 * Decoding goes through `opts.decode(value, contentEncoding)`: for a whole
 * chunk the message's own header, for a joined set its part 0's header (the
 * codec describes the joined bytes, not a single part).
 *
 * Kept free of Kafka/metrics so the rules are unit tested (replay-parts.test.ts);
 * the consumer wires in decode, metrics and the head-blocked clock.
 */

type HeaderValue = Buffer | string | (Buffer | string)[] | undefined;

export interface ReplayKafkaMessage {
  offset: string;
  timestamp: string;
  key?: Buffer | null;
  value: Buffer | null;
  headers?: Record<string, HeaderValue>;
}

export interface ReassembleOptions {
  /** Decompress a value; `contentEncoding` is its header (may be missing). */
  decode: (value: Uint8Array, contentEncoding?: string) => string;
  /** Max declared part count accepted (REPLAY_KAFKA_MAX_PARTS). */
  maxParts: number;
  abandonAfterMs: number;
  /** The batch reaches the partition high-watermark (nothing more to fetch). */
  atTail: boolean;
  /** Consumer maxBytesPerPartition and the producer's per-message limit. */
  maxBytesPerPartition: number;
  maxMessageBytes: number;
  /** How long the current head offset has been blocked (0 if it is new). */
  headBlockedMs: number;
  maxHeadBlockedMs: number;
}

export type DroppedPartSetReason = 'invalid' | 'abandoned' | 'unfetchable';

export interface DroppedPartSet {
  chunkId: string;
  reason: DroppedPartSetReason;
  firstOffset: string;
  /** Distinct part indexes present in this batch. */
  present: number;
  declared: number | null;
}

export interface ReassembleResult {
  lines: ReplayLineWithOffset[];
  /** Highest offset safe to resolve after the lines are written; null = none. */
  resolveThrough: string | null;
  /** First offset of the earliest set still waiting for parts; null = none. */
  blockedAt: string | null;
  firstTraceparent?: string;
  /** Whole-chunk (legacy) messages decoded. */
  legacy: number;
  /** Part sets joined into one line. */
  reassembled: number;
  /** Part messages skipped because their set was resolved in an earlier batch. */
  leftoverParts: number;
  dropped: DroppedPartSet[];
  decodeErrors: { offset: string; error: unknown }[];
}

interface PartSet {
  chunkId: string;
  declared: number | null;
  invalid: boolean;
  /** part index → message index (first occurrence wins; dups are ignored). */
  parts: Map<number, number>;
  /** Every message index carrying this chunk id, ascending. */
  members: number[];
}

const headerString = (v: HeaderValue): string | undefined => {
  const one = Array.isArray(v) ? v[0] : v;
  if (one === undefined) return undefined;
  return typeof one === 'string' ? one : one.toString();
};

const parseIntStrict = (v: string | undefined): number | null =>
  v !== undefined && /^\d{1,9}$/.test(v) ? Number(v) : null;

// Record-batch framing slack when telling whether a batch hit the fetch limit.
const FETCH_FULL_SLACK_BYTES = 64 * 1024;

const approxMessageBytes = (m: ReplayKafkaMessage): number => {
  // value + key + headers + ~70 bytes of record framing: close enough to tell
  // whether a batch reached the fetch limit.
  let n = 70 + (m.value?.length ?? 0) + (m.key?.length ?? 0);
  for (const [k, v] of Object.entries(m.headers ?? {})) {
    n += k.length + (headerString(v)?.length ?? 0);
  }
  return n;
};

export function reassembleReplayBatch(
  messages: ReplayKafkaMessage[],
  opts: ReassembleOptions,
): ReassembleResult {
  const result: ReassembleResult = {
    lines: [],
    resolveThrough: null,
    blockedAt: null,
    legacy: 0,
    reassembled: 0,
    leftoverParts: 0,
    dropped: [],
    decodeErrors: [],
  };
  if (messages.length === 0) return result;

  // 1. Group part messages by chunk id; validate headers.
  const sets = new Map<string, PartSet>();
  const setOf: (PartSet | null)[] = messages.map((m, i) => {
    const chunkId = headerString(m.headers?.[REPLAY_CHUNK_ID_HEADER]);
    if (chunkId === undefined) return null;
    let set = sets.get(chunkId);
    if (!set) {
      set = {
        chunkId,
        declared: null,
        invalid: false,
        parts: new Map(),
        members: [],
      };
      sets.set(chunkId, set);
    }
    set.members.push(i);
    const index = parseIntStrict(headerString(m.headers?.[REPLAY_PART_HEADER]));
    const count = parseIntStrict(
      headerString(m.headers?.[REPLAY_PARTS_HEADER]),
    );
    if (
      index === null ||
      count === null ||
      count < 2 ||
      count > opts.maxParts ||
      index >= count ||
      (set.declared !== null && set.declared !== count) ||
      !m.value
    ) {
      set.invalid = true;
      return set;
    }
    set.declared = count;
    if (!set.parts.has(index)) set.parts.set(index, i);
    return set;
  });

  // 2. Classify. The first part's offset is where a set starts; every other
  // member comes after it in a sane log, but use the lowest member to be safe.
  const offsetAt = (i: number) => Number(messages[i]!.offset);
  const firstMember = (s: PartSet) => s.members[0]!;
  const isComplete = (s: PartSet) =>
    !s.invalid && s.declared !== null && s.parts.size === s.declared;
  const dropReason = new Map<PartSet, DroppedPartSetReason>();
  const incomplete: PartSet[] = [];
  for (const s of sets.values()) {
    if (s.invalid) {
      dropReason.set(s, 'invalid');
      continue;
    }
    if (!s.parts.has(0) || isComplete(s)) continue; // leftover / complete
    const first = firstMember(s);
    const firstTs = Number(messages[s.parts.get(0)!]!.timestamp);
    let abandoned = false;
    if (Number.isFinite(firstTs)) {
      for (let j = first + 1; j < messages.length; j++) {
        const ts = Number(messages[j]!.timestamp);
        if (Number.isFinite(ts) && ts - firstTs >= opts.abandonAfterMs) {
          abandoned = true;
          break;
        }
      }
    }
    if (abandoned) {
      dropReason.set(s, 'abandoned');
    } else {
      incomplete.push(s);
    }
  }
  incomplete.sort((a, b) => firstMember(a) - firstMember(b));

  // 3. Where to cut. Only a set at the very head of the batch can be
  // unfetchable: one further in is cut at, and the redelivery starts with it.
  let cut: number | null = null; // message index of the earliest waiting set
  for (const s of incomplete) {
    if (firstMember(s) === 0 && !opts.atTail) {
      let bytes = 0;
      for (const m of messages) bytes += approxMessageBytes(m);
      const fetchFull =
        bytes >=
        opts.maxBytesPerPartition -
          opts.maxMessageBytes -
          FETCH_FULL_SLACK_BYTES;
      if (fetchFull || opts.headBlockedMs >= opts.maxHeadBlockedMs) {
        dropReason.set(s, 'unfetchable');
        continue;
      }
    }
    cut = firstMember(s);
    break;
  }
  const end = cut ?? messages.length;
  if (cut !== null) result.blockedAt = messages[cut]!.offset;
  if (end > 0) result.resolveThrough = messages[end - 1]!.offset;

  // 4. Emit lines for everything before the cut, in offset order.
  const encodingOf = (m: ReplayKafkaMessage) =>
    headerString(m.headers?.['content-encoding']);
  const tryDecode = (
    offset: string,
    value: Uint8Array,
    encoding: string | undefined,
  ): string | null => {
    try {
      return opts.decode(value, encoding);
    } catch (error) {
      result.decodeErrors.push({ offset, error });
      return null;
    }
  };
  const noteTraceparent = (m: ReplayKafkaMessage) => {
    if (!result.firstTraceparent) {
      result.firstTraceparent = headerString(m.headers?.traceparent);
    }
  };
  const reported = new Set<PartSet>();
  for (let i = 0; i < end; i++) {
    const m = messages[i]!;
    const set = setOf[i];
    if (!set) {
      if (!m.value) continue;
      const line = tryDecode(m.offset, m.value, encodingOf(m));
      if (line !== null) {
        result.lines.push({ line, offset: Number(m.offset) });
        result.legacy++;
        noteTraceparent(m);
      }
      continue;
    }
    if (i !== firstMember(set)) continue; // handled at the set's first member
    const reason = dropReason.get(set);
    if (reason) {
      if (!reported.has(set)) {
        reported.add(set);
        result.dropped.push({
          chunkId: set.chunkId,
          reason,
          firstOffset: m.offset,
          present: set.parts.size,
          declared: set.declared,
        });
      }
      continue;
    }
    if (!set.parts.has(0)) {
      // Leftover: count only the members we are passing over now (the rest
      // are counted when the redelivered batch reaches them).
      result.leftoverParts += set.members.filter((j) => j < end).length;
      continue;
    }
    // Complete (an incomplete set before the cut is impossible: the cut is
    // the earliest incomplete set).
    const ordered: Uint8Array[] = [];
    for (let p = 0; p < set.declared!; p++) {
      ordered.push(messages[set.parts.get(p)!]!.value!);
    }
    const line = tryDecode(
      m.offset,
      joinReplayParts(ordered),
      encodingOf(messages[set.parts.get(0)!]!),
    );
    if (line !== null) {
      result.lines.push({ line, offset: Number(m.offset) });
      result.reassembled++;
      noteTraceparent(messages[set.parts.get(0)!]!);
    }
  }
  return result;
}
