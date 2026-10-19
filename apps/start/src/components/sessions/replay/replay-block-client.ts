import type { DecodedBlock } from './replay-block-decode';
import type { DecodeRequest, DecodeResponse } from './replay-decode.worker';

/** The block list said source X; the server now decides differently (409). */
export class ReplayStaleListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayStaleListError';
  }
}

export type FetchReplayBlocks = (
  keys: string[],
  signal: AbortSignal,
) => Promise<Map<string, DecodedBlock>>;

export interface ReplayBlockFetcher {
  fetchBlocks: FetchReplayBlocks;
  /** Terminates the decode worker; pending decodes reject. */
  dispose: () => void;
}

const abortError = () => {
  const e = new Error('replay block request aborted');
  e.name = 'AbortError';
  return e;
};

/**
 * Fetches raw blocks from GET /replay/blocks (cookie auth, like the tRPC
 * client) and decodes them in a dedicated Web Worker. One fetcher per player
 * (window); `dispose` on unmount. Where Workers are unavailable the same
 * decoder runs on the main thread.
 */
export function createReplayBlockFetcher(opts: {
  apiUrl: string;
  projectId: string;
  sessionId: string;
  windowId: string;
  source: string;
}): ReplayBlockFetcher {
  let worker: Worker | null = null;
  let disposed = false;
  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (m: Map<string, DecodedBlock>) => void;
      reject: (e: Error) => void;
    }
  >();

  const getWorker = (): Worker | null => {
    if (worker || disposed || typeof Worker === 'undefined') return worker;
    try {
      worker = new Worker(
        new URL('./replay-decode.worker.ts', import.meta.url),
        {
          type: 'module',
          name: 'replay-decode',
        },
      );
    } catch {
      return null;
    }
    worker.onmessage = (e: MessageEvent<DecodeResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(new Map(e.data.blocks));
      else p.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || 'replay decode worker failed');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  };

  const decode = async (
    buffer: ArrayBuffer,
    signal: AbortSignal,
  ): Promise<Map<string, DecodedBlock>> => {
    const w = getWorker();
    if (!w) {
      const [{ decompress }, { decodeReplayBlocksResponse }] =
        await Promise.all([import('fzstd'), import('./replay-block-decode')]);
      return decodeReplayBlocksResponse(
        new Uint8Array(buffer),
        (d) => decompress(d),
        opts.windowId,
      );
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        // The worker finishes the decode; its reply is just ignored.
        pending.delete(id);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        resolve: (m) => {
          signal.removeEventListener('abort', onAbort);
          resolve(m);
        },
        reject: (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      });
      const msg: DecodeRequest = { id, buffer, windowId: opts.windowId };
      w.postMessage(msg, [buffer]);
    });
  };

  const fetchBlocks: FetchReplayBlocks = async (keys, signal) => {
    if (disposed) throw abortError();
    const params = new URLSearchParams({
      projectId: opts.projectId,
      sessionId: opts.sessionId,
      windowId: opts.windowId,
      source: opts.source,
      keys: keys.join(','),
    });
    const res = await fetch(`${opts.apiUrl}/replay/blocks?${params}`, {
      credentials: 'include',
      mode: 'cors',
      signal,
    });
    if (res.status === 409) {
      throw new ReplayStaleListError(await res.text().catch(() => 'stale'));
    }
    if (!res.ok) {
      throw new Error(`replay blocks request failed: HTTP ${res.status}`);
    }
    // A body cut short (server read failure mid-stream) rejects here or fails
    // the frame decode (no terminator): either way the request failed.
    const buffer = await res.arrayBuffer();
    if (signal.aborted) throw abortError();
    return decode(buffer, signal);
  };

  return {
    fetchBlocks,
    dispose: () => {
      disposed = true;
      for (const p of pending.values()) p.reject(abortError());
      pending.clear();
      worker?.terminate();
      worker = null;
    },
  };
}
