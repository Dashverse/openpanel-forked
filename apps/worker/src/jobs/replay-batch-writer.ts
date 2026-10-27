import type { ReplayLineWithOffset } from '@openpanel/db';

/**
 * One Kafka replay batch → storage, per project:
 *
 *   mode off               CH chunk insert only (Phase 1).
 *   mode dual, dual proj   CH chunk insert (source of truth, throws → redeliver)
 *                          + SHADOW block write (errors counted, never thrown).
 *   mode dual, Blob-only   NO CH insert; block write + ref insert are the only
 *   (REPLAY_BLOB_ONLY_…)   copy, so a failure THROWS → the batch's offsets are
 *                          not resolved → Kafka redelivers (fail-closed).
 *
 * A redelivery can duplicate chunks in CH and/or blocks; readers de-dup by
 * chunk, so duplicates are inert. Nothing is ever written nowhere: a line whose
 * project can't be read goes to CH.
 *
 * Kept free of Kafka/metrics so the routing + failure semantics are unit-tested
 * (replay-batch-writer.test.ts); the consumer wires in the real I/O.
 */

export type ReplayBlocksMode = 'off' | 'dual';

export interface ReplayBatchConfig {
  mode: ReplayBlocksMode;
  /** Projects whose chunks go to Blob blocks only (effective in dual mode). */
  blobOnlyProjectIds: ReadonlySet<string>;
}

export interface ReplayBatchDeps {
  insertChunks: (lines: string[]) => Promise<void>;
  writeBlocks: (
    items: ReplayLineWithOffset[],
  ) => Promise<{ blocks: number; bytes: number }>;
  /** Shadow (dual-project) block write failed - counted, not thrown. */
  onShadowError?: (err: unknown) => void;
  /** Blob-only block write failed - the batch will be redelivered. */
  onFailClosed?: (err: unknown) => void;
  /**
   * Checked before the dual shadow write: false (batch deadline nearly spent)
   * skips it. Skipping is safe: those sessions just lack blocks, and the
   * serving guard then serves them from ClickHouse, which is complete.
   */
  shadowBudgetOk?: () => boolean;
  onShadowSkipped?: () => void;
}

export interface ReplayBatchResult {
  chChunks: number;
  blobOnlyChunks: number;
  blocks: number;
  bytes: number;
}

/** CSV → set of project ids (empty/blank entries dropped). */
export function parseBlobOnlyProjectIds(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const PROJECT_ID_PREFIX = /^\{"project_id":("(?:[^"\\]|\\.)*")/;

/**
 * project_id of a replay chunk line. The API serialises `project_id` first, so
 * a prefix match avoids parsing the payload; anything else gets a full parse.
 * Null when the line can't be parsed (→ routed to CH, like before).
 */
export function replayLineProjectId(line: string): string | null {
  const m = PROJECT_ID_PREFIX.exec(line);
  if (m) {
    try {
      return JSON.parse(m[1]!) as string;
    } catch {
      // fall through
    }
  }
  try {
    const v = (JSON.parse(line) as { project_id?: unknown }).project_id;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

export async function writeReplayBatch(
  items: ReplayLineWithOffset[],
  cfg: ReplayBatchConfig,
  deps: ReplayBatchDeps,
): Promise<ReplayBatchResult> {
  const result: ReplayBatchResult = {
    chChunks: 0,
    blobOnlyChunks: 0,
    blocks: 0,
    bytes: 0,
  };
  if (items.length === 0) return result;

  if (cfg.mode !== 'dual') {
    await deps.insertChunks(items.map((i) => i.line));
    result.chChunks = items.length;
    return result;
  }

  const dualItems: ReplayLineWithOffset[] = [];
  const blobOnlyItems: ReplayLineWithOffset[] = [];
  if (cfg.blobOnlyProjectIds.size === 0) {
    dualItems.push(...items);
  } else {
    for (const item of items) {
      const projectId = replayLineProjectId(item.line);
      if (projectId !== null && cfg.blobOnlyProjectIds.has(projectId)) {
        blobOnlyItems.push(item);
      } else {
        dualItems.push(item);
      }
    }
  }

  // 1. Blob-only projects - the only copy; fail closed. Runs FIRST: if Azure
  // is down the batch fails before any CH insert, so the redeliveries during
  // an outage don't re-insert the dual projects' chunks into CH every retry.
  // (A CH failure after this point only duplicates blocks, which every block
  // reader already de-duplicates.)
  if (blobOnlyItems.length > 0) {
    try {
      const { blocks, bytes } = await deps.writeBlocks(blobOnlyItems);
      result.blocks += blocks;
      result.bytes += bytes;
      result.blobOnlyChunks = blobOnlyItems.length;
    } catch (err) {
      deps.onFailClosed?.(err);
      throw err;
    }
  }

  // 2. CH chunks (dual projects) - source of truth for them; throws.
  if (dualItems.length > 0) {
    await deps.insertChunks(dualItems.map((i) => i.line));
    result.chChunks = dualItems.length;
  }

  // 3. Dual projects - shadow write; never blocks the batch.
  if (dualItems.length > 0 && deps.shadowBudgetOk?.() === false) {
    deps.onShadowSkipped?.();
  } else if (dualItems.length > 0) {
    try {
      const { blocks, bytes } = await deps.writeBlocks(dualItems);
      result.blocks += blocks;
      result.bytes += bytes;
    } catch (err) {
      deps.onShadowError?.(err);
    }
  }
  return result;
}

/**
 * Backoff before a failed batch is retried: 1s, 2s, 4s ... capped at `maxMs`.
 * The consumer pauses the partition for this long instead of re-fetching at
 * once, so an outage is a slow retry loop, not a hot one against Azure + CH.
 * `baseMs` sets the first step (the part-set wait starts at 250ms).
 */
export function replayRetryBackoffMs(
  attempt: number,
  maxMs = 30_000,
  baseMs = 1000,
): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(maxMs, baseMs * 2 ** Math.min(n - 1, 30));
}

/** Positive integer env value, else the default (NaN would break timeouts). */
export function positiveIntEnv(raw: string | undefined, fallback: number) {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
