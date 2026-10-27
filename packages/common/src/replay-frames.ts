/**
 * Binary framing for the session-replay block data endpoint
 * (`GET /replay/blocks`). Shared by the API (encoder) and the dashboard player
 * (decoder) so both sides agree byte for byte. Pure: Uint8Array + DataView,
 * works in Node and in browsers / Web Workers.
 *
 * Layout (all integers unsigned 32-bit big-endian):
 *
 *   "OPRB"                      4 bytes magic
 *   version                     1 byte (currently 1)
 *   frame*                      zero or more frames:
 *     keyLength   u32           > 0
 *     key         keyLength     UTF-8 block key (as listed by session.replayBlocks)
 *     dataLength  u32
 *     data        dataLength    ONE zstd frame: the block's NDJSON chunk lines
 *   terminator  u32 = 0         an explicit end marker, so a body cut short
 *                               (server error mid-stream, dropped connection) is
 *                               detected instead of silently losing blocks
 *
 * Frames can arrive in any order; the client maps them back by key.
 */

export const REPLAY_FRAMES_MAGIC = 'OPRB';
export const REPLAY_FRAMES_VERSION = 1;
export const REPLAY_FRAMES_CONTENT_TYPE =
  'application/x-openpanel-replay-blocks';

const MAGIC_BYTES = new Uint8Array([0x4f, 0x50, 0x52, 0x42]); // "OPRB"
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface ReplayFrame {
  key: string;
  data: Uint8Array;
}

/** The 5-byte preamble (magic + version) every response starts with. */
export function encodeReplayFramesHeader(): Uint8Array {
  const out = new Uint8Array(5);
  out.set(MAGIC_BYTES, 0);
  out[4] = REPLAY_FRAMES_VERSION;
  return out;
}

/** One frame: key length, key, data length (the data itself is written after). */
export function encodeReplayFramePrefix(
  key: string,
  dataLength: number,
): Uint8Array {
  const keyBytes = textEncoder.encode(key);
  if (keyBytes.length === 0) {
    throw new Error('replay frame key must not be empty');
  }
  const out = new Uint8Array(4 + keyBytes.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, keyBytes.length);
  out.set(keyBytes, 4);
  view.setUint32(4 + keyBytes.length, dataLength);
  return out;
}

/** The end-of-stream marker (a zero key length). */
export function encodeReplayFramesTerminator(): Uint8Array {
  return new Uint8Array(4);
}

/** Whole response in one buffer (tests, small legacy responses). */
export function encodeReplayFrames(frames: ReplayFrame[]): Uint8Array {
  const parts: Uint8Array[] = [encodeReplayFramesHeader()];
  for (const f of frames) {
    parts.push(encodeReplayFramePrefix(f.key, f.data.length), f.data);
  }
  parts.push(encodeReplayFramesTerminator());
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export class ReplayFramesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayFramesError';
  }
}

/**
 * Parse a complete response body. Throws ReplayFramesError on a bad magic or
 * version, a frame running past the end, or a missing terminator (truncated).
 * The returned `data` views share the input buffer (no copy).
 */
export function decodeReplayFrames(body: Uint8Array): ReplayFrame[] {
  if (body.length < 5) throw new ReplayFramesError('replay frames: too short');
  for (let i = 0; i < 4; i++) {
    if (body[i] !== MAGIC_BYTES[i]) {
      throw new ReplayFramesError('replay frames: bad magic');
    }
  }
  if (body[4] !== REPLAY_FRAMES_VERSION) {
    throw new ReplayFramesError(
      `replay frames: unsupported version ${body[4]}`,
    );
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const frames: ReplayFrame[] = [];
  let at = 5;
  for (;;) {
    if (at + 4 > body.length) {
      throw new ReplayFramesError('replay frames: truncated (no terminator)');
    }
    const keyLength = view.getUint32(at);
    at += 4;
    if (keyLength === 0) break;
    if (at + keyLength + 4 > body.length) {
      throw new ReplayFramesError('replay frames: truncated frame header');
    }
    const key = textDecoder.decode(body.subarray(at, at + keyLength));
    at += keyLength;
    const dataLength = view.getUint32(at);
    at += 4;
    if (at + dataLength > body.length) {
      throw new ReplayFramesError('replay frames: truncated frame data');
    }
    frames.push({ key, data: body.subarray(at, at + dataLength) });
    at += dataLength;
  }
  return frames;
}
