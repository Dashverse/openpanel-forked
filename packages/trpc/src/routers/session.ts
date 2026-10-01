import { z } from 'zod';

import {
  replaySessionFilterFields,
  replaySortOptions,
} from '@openpanel/constants';
import {
  getReplaySessionFilterValues,
  getSessionList,
  getSessionReplayChunksAroundTime,
  getSessionReplayChunksByIndexRange,
  getSessionReplayChunksFrom,
  getSessionReplayMeta,
  getSessionWindowSegments,
  getSessionWindows,
  getSessionsCount,
  sessionHasReplay,
  sessionService,
} from '@openpanel/db';
import { zChartEventFilter } from '@openpanel/validation';

import { createTRPCRouter, protectedProcedure } from '../trpc';

const zReplaySessionFilterField = z.enum(
  Object.keys(replaySessionFilterFields) as [
    keyof typeof replaySessionFilterFields,
    ...(keyof typeof replaySessionFilterFields)[],
  ],
);

// Session Replays list: session-column filters, window, sort, duration bounds.
const zReplayListOptions = {
  replaySessionFilters: z
    .array(
      z.object({
        name: zReplaySessionFilterField,
        operator: z.enum(['is', 'isNot', 'contains', 'doesNotContain', 'gte', 'lte']),
        value: z.array(z.string()),
      }),
    )
    .optional(),
  replayDays: z.number().int().min(1).max(90).optional(),
  minReplayDurationMs: z.number().int().min(0).optional(),
  maxReplayDurationMs: z.number().int().min(0).optional(),
};

export function encodeCursor(cursor: {
  createdAt: string;
  id: string;
  offset?: number;
}): string {
  const json = JSON.stringify(cursor);
  return Buffer.from(json, 'utf8').toString('base64url'); // URL-safe
}

export function decodeCursor(
  encoded: string,
): { createdAt: string; id: string; offset?: number } | null {
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    const obj = JSON.parse(json);
    if (typeof obj.createdAt === 'string' && typeof obj.id === 'string') {
      return {
        createdAt: obj.createdAt,
        id: obj.id,
        ...(typeof obj.offset === 'number' ? { offset: obj.offset } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export const sessionRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        profileId: z.string().optional(),
        cursor: z.string().nullish(),
        filters: z.array(zChartEventFilter).default([]),
        startDate: z.date().optional(),
        endDate: z.date().optional(),
        search: z.string().optional(),
        take: z.number().default(50),
        onlyReplays: z.boolean().optional(),
        replayEventNames: z.array(z.string()).optional(),
        replayEventFilters: z.array(zChartEventFilter).optional(),
        ...zReplayListOptions,
        replaySort: z
          .enum(
            Object.keys(replaySortOptions) as [
              keyof typeof replaySortOptions,
              ...(keyof typeof replaySortOptions)[],
            ],
          )
          .optional(),
      }),
    )
    .query(async ({ input }) => {
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      const data = await getSessionList({
        ...input,
        cursor,
      });
      return {
        data: data.items,
        meta: {
          next: data.meta.next ? encodeCursor(data.meta.next) : undefined,
        },
      };
    }),

  // Total number of sessions that have a replay recording — the "N replays"
  // header on the Session Replays tab.
  replayCount: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        startDate: z.date().optional(),
        endDate: z.date().optional(),
        search: z.string().optional(),
        replayEventNames: z.array(z.string()).optional(),
        replayEventFilters: z.array(zChartEventFilter).optional(),
        ...zReplayListOptions,
      }),
    )
    .query(async ({ input }) => {
      return getSessionsCount({ ...input, onlyReplays: true });
    }),

  // Value suggestions for a session-field filter on the Session Replays tab.
  replayFilterValues: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        field: zReplaySessionFilterField,
        replayDays: z.number().int().min(1).max(90).optional(),
      }),
    )
    .query(async ({ input }) => {
      return getReplaySessionFilterValues({
        projectId: input.projectId,
        field: input.field,
        days: input.replayDays,
      });
    }),

  byId: protectedProcedure
    .input(z.object({ sessionId: z.string(), projectId: z.string() }))
    .query(async ({ input: { sessionId, projectId } }) => {
      return sessionService.byId(sessionId, projectId);
    }),

  hasReplay: protectedProcedure
    .input(z.object({ sessionId: z.string(), projectId: z.string() }))
    .query(({ input: { sessionId, projectId } }) => {
      return sessionHasReplay(sessionId, projectId);
    }),

  replayChunksFrom: protectedProcedure
    .input(
      z.object({
        sessionId: z.string(),
        projectId: z.string(),
        fromIndex: z.number().int().min(0).default(0),
        // When set, restrict chunks to a single recorder (tab / page-load).
        // Keeps multi-tab sessions playable — one window's chunk_index
        // sequence is clean 0..N with no cross-recorder mixing.
        windowId: z.string().optional(),
      }),
    )
    .query(({ input: { sessionId, projectId, fromIndex, windowId } }) => {
      return getSessionReplayChunksFrom(
        sessionId,
        projectId,
        fromIndex,
        windowId,
      );
    }),

  replayWindows: protectedProcedure
    .input(z.object({ sessionId: z.string(), projectId: z.string() }))
    .query(({ input: { sessionId, projectId } }) => {
      return getSessionWindows(sessionId, projectId);
    }),

  replayMeta: protectedProcedure
    .input(z.object({ sessionId: z.string(), projectId: z.string() }))
    .query(({ input: { sessionId, projectId } }) => {
      return getSessionReplayMeta(sessionId, projectId);
    }),

  // Active recording segments for a window (idle gaps collapsed) — drives the
  // gap-collapsed scrubber so a mostly-idle multi-hour tab shows its real
  // minutes of activity.
  replayWindowSegments: protectedProcedure
    .input(
      z.object({
        sessionId: z.string(),
        projectId: z.string(),
        windowId: z.string().optional(),
      }),
    )
    .query(({ input: { sessionId, projectId, windowId } }) => {
      return getSessionWindowSegments(sessionId, projectId, windowId);
    }),

  replayChunksByIndexRange: protectedProcedure
    .input(
      z.object({
        sessionId: z.string(),
        projectId: z.string(),
        fromIndex: z.number().min(0),
        toIndex: z.number().min(0),
        windowId: z.string().optional(),
      }),
    )
    .query(
      ({ input: { sessionId, projectId, fromIndex, toIndex, windowId } }) => {
        return getSessionReplayChunksByIndexRange(
          sessionId,
          projectId,
          fromIndex,
          toIndex,
          windowId,
        );
      },
    ),

  /**
   * Smart seek — given a target wall-clock ms inside the session, returns the
   * latest full-snapshot chunk before the target plus everything through
   * target + lookahead. One round trip, ~30 sec of chunks, regardless of how
   * far into the session the target is.
   */
  replayChunksAroundTime: protectedProcedure
    .input(
      z.object({
        sessionId: z.string(),
        projectId: z.string(),
        // Accept floats — rrweb timestamps can be non-integer (Math.random
        // jitter in chunked emission, accumulating ms drift). Floored
        // server-side inside getSessionReplayChunksAroundTime.
        targetMs: z.number().min(0),
        lookaheadMs: z.number().min(0).max(120_000).default(30_000),
        windowId: z.string().optional(),
      }),
    )
    .query(
      ({ input: { sessionId, projectId, targetMs, lookaheadMs, windowId } }) => {
        return getSessionReplayChunksAroundTime(
          sessionId,
          projectId,
          targetMs,
          lookaheadMs,
          windowId,
        );
      },
    ),
});
