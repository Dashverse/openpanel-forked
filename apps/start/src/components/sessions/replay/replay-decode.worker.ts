/**
 * Replay block decoder (Web Worker): zstd decompression (fzstd, pure JS, MIT),
 * NDJSON split and JSON.parse of the chunk rows and their rrweb payloads, off
 * the main thread. One request in, one reply out, matched by `id`.
 */
import { decompress } from 'fzstd';
import {
  type DecodedBlock,
  decodeReplayBlocksResponse,
} from './replay-block-decode';

export type DecodeRequest = {
  id: number;
  buffer: ArrayBuffer;
  windowId?: string;
};

export type DecodeResponse =
  | { id: number; ok: true; blocks: [string, DecodedBlock][] }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<DecodeRequest>) => void) | null;
  postMessage: (msg: DecodeResponse) => void;
};

ctx.onmessage = (e) => {
  const { id, buffer, windowId } = e.data;
  try {
    const blocks = decodeReplayBlocksResponse(
      new Uint8Array(buffer),
      (data) => decompress(data),
      windowId,
    );
    ctx.postMessage({ id, ok: true, blocks: Array.from(blocks.entries()) });
  } catch (error) {
    ctx.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
