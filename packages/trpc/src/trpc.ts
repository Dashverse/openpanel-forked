import { TRPCError, initTRPC } from '@trpc/server';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { has } from 'ramda';
import superjson from 'superjson';
import { ZodError } from 'zod';

import { COOKIE_OPTIONS, type SessionValidationResult } from '@openpanel/auth';
import { runWithAlsSession } from '@openpanel/db';
import { getRedisCache } from '@openpanel/redis';
import type { ISetCookie } from '@openpanel/validation';
import {
  createTrpcRedisLimiter,
  defaultFingerPrint,
} from '@trpc-limiter/redis';
import { getOrganizationAccess, getProjectAccess } from './access';
import { TRPCAccessError } from './errors';

export const rateLimitMiddleware = ({
  max,
  windowMs,
}: {
  max: number;
  windowMs: number;
}) =>
  createTrpcRedisLimiter<typeof t>({
    fingerprint: (ctx) => defaultFingerPrint(ctx.req),
    message: (hitInfo) =>
      `Too many requests, please try again later. ${hitInfo}`,
    max,
    windowMs,
    redisClient: getRedisCache(),
  });

export async function createContext({ req, res }: CreateFastifyContextOptions) {
  const cookies = (req as any).cookies as Record<string, string | undefined>;
  const setCookie: ISetCookie = (key, value, options) => {
    // @ts-ignore
    res.setCookie(key, value, {
      maxAge: options.maxAge,
      ...COOKIE_OPTIONS,
    });
  };

  if (process.env.NODE_ENV !== 'production') {
    await new Promise((res) =>
      setTimeout(() => res(1), Math.min(Math.random() * 500, 200)),
    );
  }

  return {
    req,
    res,
    session: (req as any).session as SessionValidationResult,
    // we do not get types for `setCookie` from fastify
    // so define it here and be safe in routers
    setCookie,
    cookies,
  };
}
export type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

const enforceUserIsAuthed = t.middleware(async ({ ctx, next }) => {
  if (!ctx.session?.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
  }

  try {
    return next({
      ctx: {
        session: { ...ctx.session },
      },
    });
  } catch (error) {
    console.error('Failes to get user', error);
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Failed to get user',
    });
  }
});

// Only used on protected routes
const enforceAccess = t.middleware(async ({ ctx, next, type, getRawInput }) => {
  const sessionId = ctx.session?.session?.id ?? null;
  return runWithAlsSession(sessionId, async () => {
    const rawInput = await getRawInput();
    if (type === 'mutation' && process.env.DEMO_USER_ID) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You are not allowed to do this in demo mode',
      });
    }

    if (has('projectId', rawInput)) {
      const access = await getProjectAccess({
        userId: ctx.session.userId!,
        projectId: rawInput.projectId as string,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this project');
      }
    }

    if (has('organizationId', rawInput)) {
      const access = await getOrganizationAccess({
        userId: ctx.session.userId!,
        organizationId: rawInput.organizationId as string,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this organization');
      }
    }

    return next();
  });
});

export const createTRPCRouter = t.router;

const loggerMiddleware = t.middleware(
  async ({ ctx, next, getRawInput, path, input, type }) => {
    const rawInput = await getRawInput();
    // Only log mutations
    if (type === 'mutation') {
      ctx.req.log.info('TRPC mutation', {
        path,
        rawInput,
        input,
        userId: ctx.session?.userId,
        organizationId: has('organizationId', rawInput)
          ? rawInput.organizationId
          : undefined,
        projectId: has('projectId', rawInput) ? rawInput.projectId : undefined,
      });
    }
    return next();
  },
);

const sessionScopeMiddleware = t.middleware(async ({ ctx, next }) => {
  const sessionId = ctx.session?.session?.id ?? null;
  return runWithAlsSession(sessionId, async () => {
    return next();
  });
});

export const publicProcedure = t.procedure
  .use(loggerMiddleware)
  .use(sessionScopeMiddleware);
export const protectedProcedure = t.procedure
  .use(enforceUserIsAuthed)
  .use(enforceAccess)
  .use(loggerMiddleware)
  .use(sessionScopeMiddleware);

const middlewareMarker = 'middlewareMarker' as 'middlewareMarker' & {
  __brand: 'middlewareMarker';
};

export const cacheMiddleware = (
  cbOrTtl: number | ((input: any, opts: { path: string }) => number),
  options?: {
    // Build the cache key from a normalized view of the raw input — e.g. strip
    // presentational/volatile fields (layout, id, name, …) so they don't bloat
    // the key or spawn new entries on every UI change. Defaults to the full
    // raw input.
    keyInput?: (rawInput: any) => unknown;
  },
) =>
  t.middleware(async ({ ctx, next, path, type, getRawInput, input }) => {
    const ttl =
      typeof cbOrTtl === 'function' ? cbOrTtl(input, { path }) : cbOrTtl;
    if (!ttl) {
      return next();
    }
    const rawInput = await getRawInput();
    if (type !== 'query') {
      return next();
    }
    const keySource = options?.keyInput ? options.keyInput(rawInput) : rawInput;
    let key = `trpc:${path}:`;
    if (keySource) {
      key += JSON.stringify(keySource).replace(/\"/g, "'");
    }

    // A client "Reload" sends this header to force fresh data. We skip the
    // cache READ but still recompute and write below, so the refreshed value
    // repopulates the cache for every other viewer of the same query.
    // Gated on an authenticated session: otherwise an anonymous caller on a
    // public procedure (chart.chart via a shared dashboard) could spam this
    // header to force fresh ClickHouse recomputes and bypass the cache (DoS).
    const skipCacheRead =
      !!ctx.session?.userId &&
      (ctx.req as any)?.headers?.['x-op-skip-cache'] === '1';

    // Cache reads are on in production; locally set ENABLE_TRPC_CACHE=1 to test
    // the cache path in dev (writes happen regardless).
    const cacheReadEnabled =
      process.env.NODE_ENV === 'production' ||
      process.env.ENABLE_TRPC_CACHE === '1';

    if (!skipCacheRead && cacheReadEnabled) {
      const cache = await getRedisCache().getJson(key);
      if (cache) {
        return {
          ok: true,
          data: cache,
          ctx,
          marker: middlewareMarker,
        };
      }
    }
    const result = await next();

    // @ts-expect-error
    const data = result.data;
    if (data && typeof data === 'object') {
      // Stamp when this data was actually computed (i.e. fetched from
      // ClickHouse). It's written INTO the cached payload, so a later cache HIT
      // still reports the original compute time — not when the client read it.
      // Clients use this for an honest "last updated" indicator. We shallow-copy
      // rather than mutate tRPC's internal result object; arrays can't carry the
      // field so they're cached as-is.
      const stamped = Array.isArray(data)
        ? data
        : { ...data, __computedAt: Date.now() };
      getRedisCache().setJson(key, ttl, stamped);
      return { ...result, data: stamped };
    }
    return result;
  });
