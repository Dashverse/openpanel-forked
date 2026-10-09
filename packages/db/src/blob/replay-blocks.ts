/**
 * Azure Blob I/O for the blob-primary session-replay path (Phase 2).
 *
 * Raw replay bytes live here, not in ClickHouse. Blocks are appended to an
 * append blob per (date, project, session) —
 * `blocks/dt=<date>/project=<pid>/session=<sid>.zst`; each consumer write
 * appends one independently-zstd'd **block** and a reference row in
 * `session_replay_blocks` records its `[byte_start, byte_end)` and `blob_path`.
 *
 * Readers MUST decode one block per ref (range-GET exactly that ref's bytes):
 * Node's zstd decoder stops after the first frame, so a whole-blob / multi-block
 * read would silently return only the first block. A session can also span more
 * than one blob (the `dt=` is the first chunk's date, so a session crossing UTC
 * midnight lands in two) — always go through the refs' `blob_path`, never assume
 * one blob per session.
 *
 * zstd is Node 22's native `node:zlib` (same codec as the cold archive). The
 * archive's own blobs use the `azureBlobStorage()` ClickHouse table function and
 * live under a different prefix; this module is the only Node-side blob writer.
 */
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import {
  BlobSASPermissions,
  BlobServiceClient,
  type ContainerClient,
  RestError,
} from '@azure/storage-blob';

const CONN = process.env.AZURE_BLOB_CONNECTION_STRING;
const CONTAINER = process.env.REPLAY_ARCHIVE_CONTAINER || 'clickhouse-export';
// Distinct prefix so blocks never collide with the archive's `.native.zst`.
const PREFIX = process.env.REPLAY_BLOCKS_PREFIX || 'blocks';

const positiveIntEnv = (name: string, fallback: number): number => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
// The SDK default is no per-try timeout and 4 retries, so one slow call could
// hold a Kafka batch past the consumer's rebalance timeout. Bound every try and
// the number of tries; callers also pass an overall abortSignal.
const BLOB_TRY_TIMEOUT_MS = positiveIntEnv(
  'REPLAY_BLOCKS_TRY_TIMEOUT_MS',
  10_000,
);
const BLOB_MAX_TRIES = positiveIntEnv('REPLAY_BLOCKS_MAX_TRIES', 2);

export const isReplayBlockStoreConfigured = (): boolean => Boolean(CONN);

let container: ContainerClient | null = null;
const getContainer = (): ContainerClient => {
  if (!CONN) {
    throw new Error(
      'AZURE_BLOB_CONNECTION_STRING is not set; cannot use the replay block store',
    );
  }
  if (!container) {
    container = BlobServiceClient.fromConnectionString(CONN, {
      retryOptions: {
        tryTimeoutInMs: BLOB_TRY_TIMEOUT_MS,
        maxTries: BLOB_MAX_TRIES,
      },
    }).getContainerClient(CONTAINER);
  }
  return container;
};

/**
 * `blocks/dt=YYYY-MM-DD/project=<pid>/session=<sid>.zst`. `dt` is the date of
 * the block's first chunk, so one session can span several blobs.
 */
export const replayBlockBlobPath = (
  projectId: string,
  sessionId: string,
  startedAt: string | Date,
): string => {
  const d = typeof startedAt === 'string' ? new Date(startedAt) : startedAt;
  const dt = Number.isNaN(d.getTime())
    ? new Date().toISOString().slice(0, 10)
    : d.toISOString().slice(0, 10);
  return `${PREFIX}/dt=${dt}/project=${encodeURIComponent(projectId)}/session=${encodeURIComponent(sessionId)}.zst`;
};

/**
 * zstd-compress NDJSON chunk lines into one wire block. Every line — including
 * the last — is newline-terminated, so decompressed blocks can be concatenated
 * without gluing two rows together.
 */
export const compressReplayBlock = (lines: string[]): Buffer =>
  zstdCompressSync(Buffer.from(lines.map((l) => `${l}\n`).join('')));

/** Reverse of `compressReplayBlock` for ONE block — returns its NDJSON lines. */
export const decompressReplayBlock = (buf: Buffer): string[] => {
  const text = zstdDecompressSync(buf).toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
};

export interface AppendedBlock {
  byteStart: number;
  byteEnd: number; // exclusive
}

const isBlobNotFound = (err: unknown): boolean =>
  err instanceof RestError &&
  (err.statusCode === 404 ||
    (err as RestError & { code?: string }).code === 'BlobNotFound');

/**
 * Append one compressed block to an append blob and return the byte range it
 * occupies. The offset comes from the append response (`blobAppendOffset`), which
 * is atomic even if two writers append to the same blob (e.g. the old and new
 * partition owner during a rebalance) — reading the length first would not be.
 * The blob is created only on a 404, so the common case is one round trip.
 */
export const appendReplayBlock = async (
  blobPath: string,
  block: Buffer,
  opts: { abortSignal?: AbortSignal } = {},
): Promise<AppendedBlock> => {
  const client = getContainer().getAppendBlobClient(blobPath);
  const append = async () => {
    const res = await client.appendBlock(block, block.length, {
      abortSignal: opts.abortSignal,
    });
    const byteStart = Number(res.blobAppendOffset);
    if (!Number.isFinite(byteStart)) {
      throw new Error(`append to ${blobPath} returned no blobAppendOffset`);
    }
    return { byteStart, byteEnd: byteStart + block.length };
  };
  try {
    return await append();
  } catch (err) {
    if (!isBlobNotFound(err)) {
      throw err;
    }
    await client.createIfNotExists({ abortSignal: opts.abortSignal });
    return append();
  }
};

/** Range-GET one block: `[byteStart, byteStart+count)` of a block blob. */
export const readReplayBlockRange = async (
  blobPath: string,
  byteStart: number,
  count: number,
): Promise<Buffer> =>
  getContainer().getBlobClient(blobPath).downloadToBuffer(byteStart, count);

/**
 * Short-lived read-only SAS URL for one blob (download/export fast path). A
 * session may span several blobs and a blob holds several zstd frames, so a
 * consumer of this URL must still split it by the refs' byte ranges.
 */
export const replayBlockSasUrl = async (
  blobPath: string,
  ttlMs = 10 * 60 * 1000,
): Promise<string> =>
  getContainer()
    .getBlobClient(blobPath)
    .generateSasUrl({
      permissions: BlobSASPermissions.parse('r'),
      expiresOn: new Date(Date.now() + ttlMs),
    });
