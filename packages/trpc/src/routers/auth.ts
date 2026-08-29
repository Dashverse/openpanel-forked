import {
  Arctic,
  COOKIE_OPTIONS,
  deleteSessionTokenCookie,
  getGoogleAuthConfig,
  getGoogleOAuthClient,
  invalidateSession,
  setSessionTokenCookie,
  validateSessionToken,
  verifyPasswordHash,
} from '@openpanel/auth';
import { getShareOverviewById } from '@openpanel/db';
import { zSignInShare } from '@openpanel/validation';
import { z } from 'zod';
import { TRPCAccessError, TRPCNotFoundError } from '../errors';
import {
  createTRPCRouter,
  publicProcedure,
  rateLimitMiddleware,
} from '../trpc';

const zProvider = z.literal('google');

export const authRouter = createTRPCRouter({
  signOut: publicProcedure.mutation(async ({ ctx }) => {
    deleteSessionTokenCookie(ctx.setCookie);
    if (ctx.session?.session?.id) {
      await invalidateSession(ctx.session.session.id);
    }
  }),
  signInOAuth: publicProcedure
    .input(z.object({ provider: zProvider, inviteId: z.string().nullish() }))
    .mutation(async ({ input, ctx }) => {
      if (input.inviteId) {
        ctx.setCookie('inviteId', input.inviteId, {
          maxAge: 60 * 10,
        });
      }

      const config = getGoogleAuthConfig();
      const google = getGoogleOAuthClient();
      const state = Arctic.generateState();
      const codeVerifier = Arctic.generateCodeVerifier();
      const url = google.createAuthorizationURL(state, codeVerifier, [
        'openid',
        'profile',
        'email',
      ]);
      // `hd` is only a Google account-chooser hint; it takes a single domain.
      // With several allowed domains, send none and let the server-side check
      // in parseGoogleIdentity be the authority.
      if (config.allowedDomains.length === 1) {
        url.searchParams.set('hd', config.allowedDomains[0]!);
      }

      ctx.setCookie('google_oauth_state', state, {
        maxAge: 60 * 10,
      });
      ctx.setCookie('google_code_verifier', codeVerifier, {
        maxAge: 60 * 10,
      });

      return {
        type: 'google',
        url: url.toString(),
      };
    }),
  session: publicProcedure.query(async ({ ctx }) => {
    return ctx.session;
  }),

  extendSession: publicProcedure.mutation(async ({ ctx }) => {
    if (!ctx.session.session || !ctx.cookies.session) {
      return { extended: false };
    }

    const token = ctx.cookies.session;
    const session = await validateSessionToken(token);

    if (session.session) {
      // Re-set the cookie with updated expiration
      setSessionTokenCookie(ctx.setCookie, token, session.session.expiresAt);
      return {
        extended: true,
        expiresAt: session.session.expiresAt,
      };
    }

    return { extended: false };
  }),

  signInShare: publicProcedure
    .use(
      rateLimitMiddleware({
        max: 3,
        windowMs: 30_000,
      }),
    )
    .input(zSignInShare)
    .mutation(async ({ input, ctx }) => {
      const { password, shareId } = input;
      const share = await getShareOverviewById(input.shareId);

      if (!share) {
        throw TRPCNotFoundError('Share not found');
      }

      if (!share.public) {
        throw TRPCNotFoundError('Share is not public');
      }

      if (!share.password) {
        throw TRPCNotFoundError('Share is not password protected');
      }

      const validPassword = await verifyPasswordHash(share.password, password);

      if (!validPassword) {
        throw TRPCAccessError('Incorrect password');
      }

      ctx.setCookie(`shared-overview-${shareId}`, '1', {
        maxAge: 60 * 60 * 24 * 7,
        ...COOKIE_OPTIONS,
      });

      return true;
    }),
});
