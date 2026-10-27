import {
  Arctic,
  COOKIE_OPTIONS,
  createSession,
  deleteSessionTokenCookie,
  describeAllowedDomains,
  generateSessionToken,
  github,
  google,
  hashPassword,
  invalidateSession,
  isEmailDomainAllowed,
  isGithubLoginEnabled,
  isPasswordLoginEnabled,
  isPasswordSignUpEnabled,
  setSessionTokenCookie,
  validateSessionToken,
  verifyPasswordHash,
} from '@openpanel/auth';
import { generateSecureId } from '@openpanel/common/server';
import {
  connectUserToOrganization,
  db,
  getIsRegistrationAllowed,
  getShareOverviewById,
  getUserAccount,
} from '@openpanel/db';
import { sendEmail } from '@openpanel/email';
import { deleteCache } from '@openpanel/redis';
import {
  zRequestResetPassword,
  zResetPassword,
  zSignInEmail,
  zSignInShare,
  zSignUpEmail,
} from '@openpanel/validation';
import { z } from 'zod';
import { TRPCAccessError, TRPCNotFoundError } from '../errors';
import {
  createTRPCRouter,
  publicProcedure,
  rateLimitMiddleware,
} from '../trpc';

const zProvider = z.enum(['email', 'google', 'github']);

function assertPasswordLoginEnabled() {
  if (!isPasswordLoginEnabled()) {
    throw TRPCAccessError(
      'Password sign-in is turned off. Continue with Google instead.',
    );
  }
}

function assertEmailDomainAllowed(email: string) {
  if (!isEmailDomainAllowed(email)) {
    throw TRPCAccessError(
      `Only ${describeAllowedDomains()} accounts can use this dashboard`,
    );
  }
}

/**
 * Best-effort invite redemption for a user that just authenticated. A broken
 * or expired invite must not block the sign-in itself.
 */
async function redeemInvite(
  user: Parameters<typeof connectUserToOrganization>[0]['user'],
  inviteId: string,
  log: { warn: (obj: unknown, msg?: string) => void },
) {
  try {
    await connectUserToOrganization({ user, inviteId });
  } catch (error) {
    log.warn({ error, inviteId, userId: user.id }, 'could not redeem invite');
  }
}

export const authRouter = createTRPCRouter({
  // Which sign-in methods the login and invite pages should offer
  providers: publicProcedure.query(() => {
    return {
      google: !!process.env.GOOGLE_CLIENT_ID,
      github: isGithubLoginEnabled(),
      password: isPasswordLoginEnabled(),
      passwordSignUp: isPasswordSignUpEnabled(),
    };
  }),
  signOut: publicProcedure.mutation(async ({ ctx }) => {
    deleteSessionTokenCookie(ctx.setCookie);
    if (ctx.session?.session?.id) {
      await invalidateSession(ctx.session.session.id);
    }
  }),
  signInOAuth: publicProcedure
    .input(z.object({ provider: zProvider, inviteId: z.string().nullish() }))
    .mutation(async ({ input, ctx }) => {
      // Whether a *new* user may register is decided in the OAuth callback,
      // once we know who they are. Checking here would also block returning
      // users, since a sign-in and a sign-up look the same at this point.
      const { provider } = input;

      if (provider === 'github' && !isGithubLoginEnabled()) {
        throw TRPCAccessError('GitHub sign-in is not available');
      }

      if (input.inviteId) {
        ctx.setCookie('inviteId', input.inviteId, {
          maxAge: 60 * 10,
        });
      }

      if (provider === 'github') {
        const state = Arctic.generateState();
        const url = github.createAuthorizationURL(state, [
          'user:email',
          'user:read',
        ]);

        ctx.setCookie('github_oauth_state', state, {
          maxAge: 60 * 10,
        });

        return {
          type: 'github',
          url: url.toString(),
        };
      }

      const state = Arctic.generateState();
      const codeVerifier = Arctic.generateCodeVerifier();
      const url = google.createAuthorizationURL(state, codeVerifier, [
        'openid',
        'profile',
        'email',
      ]);

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
  signUpEmail: publicProcedure
    .input(zSignUpEmail)
    .mutation(async ({ input, ctx }) => {
      if (!isPasswordSignUpEnabled()) {
        throw TRPCAccessError(
          'Accounts are created by signing in with Google from your invite.',
        );
      }
      assertEmailDomainAllowed(input.email);

      const isRegistrationAllowed = await getIsRegistrationAllowed({
        inviteId: input.inviteId,
      });

      if (!isRegistrationAllowed) {
        throw TRPCAccessError(
          'You need an invite to access OpenPanel. Ask an admin to invite you.',
        );
      }

      // A self-typed email proves nothing, so the invite link must belong to
      // the address signing up.
      if (input.inviteId) {
        const invite = await db.invite.findUnique({
          where: { id: input.inviteId },
        });
        if (
          invite &&
          invite.email.toLowerCase() !== input.email.trim().toLowerCase()
        ) {
          throw TRPCAccessError(
            'This invite was sent to a different email address',
          );
        }
      }

      const provider = 'email';
      const user = await getUserAccount({
        email: input.email,
        provider,
      });

      if (user) {
        throw TRPCNotFoundError('User already exists');
      }

      const createdUser = await db.user.create({
        data: {
          id: generateSecureId('user'),
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          accounts: {
            create: {
              provider,
              password: await hashPassword(input.password),
            },
          },
        },
      });

      if (input.inviteId) {
        await redeemInvite(createdUser, input.inviteId, ctx.req.log);
      }

      const token = generateSessionToken();
      const session = await createSession(token, createdUser.id);

      setSessionTokenCookie(ctx.setCookie, token, session.expiresAt);
      return session;
    }),
  signInEmail: publicProcedure
    .use(
      rateLimitMiddleware({
        max: 3,
        windowMs: 30_000,
      }),
    )
    .input(zSignInEmail)
    .mutation(async ({ input, ctx }) => {
      assertPasswordLoginEnabled();
      const provider = 'email';
      const password = input.password.trim();

      const user = await getUserAccount({
        email: input.email,
        provider,
      });

      if (!user) {
        throw TRPCNotFoundError('User does not exists');
      }

      assertEmailDomainAllowed(user.email);

      if (provider === 'email') {
        // if the password starts with $argon2 we use the new password hashing
        // otherwise its legacy from Clerk which uses bcrypt
        // TODO: Remove this after 2025-06-01 (half year from now)
        if (user.account.password?.startsWith('$argon2')) {
          const validPassword = await verifyPasswordHash(
            user.account.password ?? '',
            password,
          );

          if (!validPassword) {
            throw TRPCAccessError('Incorrect email or password');
          }
        } else {
          throw TRPCAccessError(
            'Reset your password, old password has expired',
          );
        }
      }

      if (input.inviteId) {
        await redeemInvite(user, input.inviteId, ctx.req.log);
      }

      const token = generateSessionToken();
      const session = await createSession(token, user.id);
      setSessionTokenCookie(ctx.setCookie, token, session.expiresAt);
      return {
        type: 'email',
      };
    }),

  resetPassword: publicProcedure
    .input(zResetPassword)
    .use(
      rateLimitMiddleware({
        max: 3,
        windowMs: 60_000,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertPasswordLoginEnabled();
      const { token, password } = input;

      const resetPassword = await db.resetPassword.findUnique({
        where: {
          id: token,
        },
      });

      if (!resetPassword) {
        throw TRPCNotFoundError('Reset password not found');
      }

      if (resetPassword.expiresAt < new Date()) {
        throw TRPCNotFoundError('Reset password expired');
      }

      await db.account.update({
        where: { id: resetPassword.accountId },
        data: {
          password: await hashPassword(password),
        },
      });

      await db.resetPassword.delete({
        where: { id: token },
      });

      return true;
    }),

  requestResetPassword: publicProcedure
    .use(
      rateLimitMiddleware({
        max: 3,
        windowMs: 60_000,
      }),
    )
    .input(zRequestResetPassword)
    .mutation(async ({ input, ctx }) => {
      assertPasswordLoginEnabled();
      const user = await getUserAccount({
        email: input.email,
        provider: 'email',
      });

      if (!user || !isEmailDomainAllowed(user.email)) {
        return true;
      }

      if (!user.account.id) {
        return true;
      }

      await db.resetPassword.deleteMany({
        where: {
          accountId: user.account.id,
        },
      });

      const token = generateSecureId('pw');
      // expires in 10 minutes
      const expiresAt = new Date(Date.now() + 1000 * 60 * 10);

      await db.resetPassword.create({
        data: {
          id: token,
          expiresAt,
          accountId: user.account.id,
        },
      });

      await sendEmail('reset-password', {
        to: input.email,
        data: {
          url: `${process.env.DASHBOARD_URL || process.env.NEXT_PUBLIC_DASHBOARD_URL}/reset-password?token=${token}`,
        },
      });

      return true;
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
