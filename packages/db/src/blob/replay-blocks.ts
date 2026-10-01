/**
 * Azure Blob I/O for the blob-primary session-replay path (Phase 2).
 *
 * Raw replay bytes live here, not in ClickHouse. One **append blob per session**
 * (`blocks/dt=<date>/project=<pid>/session=<sid>.zst`); each consumer flush
 * appends one independently-zstd'd **block** at a tracked byte offset, and a
 * reference row in `session_replay_blocks` records `[byte_start, byte_end)` so the
 * player can range-GET exactly the bytes it needs.
 *
 * zstd is Node 22's native `node:zlib` (same codec as the cold archive). The
 * archive's own blobs use the `azureBlobStorage()` ClickHouse table function and
 * live under a different prefix; this module is the only Node-side blob writer.
 */
import {
  type AppendBlobClient,
  BlobSASPermissions,
  BlobServiceClient,
  type ContainerClient,
} from '@azure/storage-blob';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const CONN = process.env.AZURE_BLOB_CONNECTION_STRING;
const CONTAINER = process.env.REPLAY_ARCHIVE_CONTAINER || 'clickhouse-export';
// Distinct prefix so blocks never collide with the archive's `.native.zst`.
const PREFIX = process.env.REPLAY_BLOCKS_PREFIX || 'blocks';

export const isReplayBlockStoreConfigured = (): boolean => Boolean(CONN);

let container: ContainerClient | null = null;
const getContainer = (): ContainerClient => {
  if (!CONN) {
    throw new Error(
      'AZURE_BLOB_CONNECTION_STRING is not set; cannot use the replay block store',
    );
  }
  if (!container) {
    container = BlobServiceClient.fromConnectionString(CONN).getContainerClient(
      CONTAINER,
    );
  }
  return container;
};

/** `blocks/dt=YYYY-MM-DD/project=<pid>/session=<sid>.zst` — one blob per session. */
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

/** zstd-compress NDJSON chunk lines into one wire block. */
export const compressReplayBlock = (lines: string[]): Buffer =>
  zstdCompressSync(Buffer.from(lines.join('\n')));

/** Reverse of `compressReplayBlock` — returns the NDJSON lines of a block. */
export const decompressReplayBlock = (buf: Buffer): string[] =>
  zstdDecompressSync(buf).toString('utf8').split('\n');

export interface AppendedBlock {
  byteStart: number;
  byteEnd: number; // exclusive
}

/**
 * Append one compressed block to a session's append blob and return the byte
 * range it occupies. The append blob is created on first write. Appends to one
 * session happen on a single consumer instance (session ⊂ device ⊂ one Kafka
 * partition), so there is no cross-writer contention and offsets stay monotonic.
 */
export const appendReplayBlock = async (
  blobPath: string,
  block: Buffer,
): Promise<AppendedBlock> => {
  const client: AppendBlobClient = getContainer().getAppendBlobClient(blobPath);
  await client.createIfNotExists();
  const props = await client.getProperties();
  const byteStart = props.contentLength ?? 0;
  await client.appendBlock(block, block.length);
  return { byteStart, byteEnd: byteStart + block.length };
};

/** Range-GET `[byteStart, byteStart+count)` of a block blob. */
export const readReplayBlockRange = async (
  blobPath: string,
  byteStart: number,
  count: number,
): Promise<Buffer> =>
  getContainer().getBlobClient(blobPath).downloadToBuffer(byteStart, count);

/** Short-lived read-only SAS URL for a session blob (download/export fast path). */
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
