import { LogError } from '@/utils/errors';
import {
  Arctic,
  GoogleAuthPolicyError,
  type GoogleIdentity,
  type OAuth2Tokens,
  createSession,
  generateSessionToken,
  getGoogleAuthConfig,
  getGoogleOAuthClient,
  getGoogleWorkspaceVerificationMarker,
  parseGoogleIdentity,
  setSessionTokenCookie,
} from '@openpanel/auth';
import {
  Prisma,
  type User,
  connectUserToDefaultOrganization,
  connectUserToOrganization,
  db,
} from '@openpanel/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type GoogleAccountRepository,
  resolveGoogleUserWithConflictRetry,
} from './oauth-account-linking';

async function fetchGoogleUser(
  tokens: OAuth2Tokens,
  allowedDomains: string[],
): Promise<GoogleIdentity> {
  const claims = Arctic.decodeIdToken(tokens.idToken());
  try {
    return parseGoogleIdentity(claims, allowedDomains);
  } catch (error) {
    if (error instanceof GoogleAuthPolicyError) {
      throw new LogError(error.message);
    }
    throw error;
  }
}

const googleAccountRepository: GoogleAccountRepository<User> = {
  async findGoogleAccountByProviderId(providerId) {
    const account = await db.$primary().account.findFirst({
      where: { provider: 'google', providerId },
      include: { user: true },
    });
    return account ? { accountId: account.id, user: account.user } : null;
  },
  async findMigratableGoogleAccountByEmail(email) {
    const account = await db.$primary().account.findFirst({
      where: {
        OR: [
          {
            provider: 'google',
            providerId: null,
            email: { equals: email, mode: 'insensitive' },
          },
          {
            provider: 'oauth',
            user: {
              email: { equals: email, mode: 'insensitive' },
            },
          },
        ],
      },
      include: { user: true },
    });
    return account ? { accountId: account.id, user: account.user } : null;
  },
  findUserByEmail(email) {
    return db.$primary().user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
  },
  async updateGoogleAccount(accountId, identity) {
    await db.account.update({
      where: { id: accountId },
      data: {
        provider: 'google',
        providerId: identity.id,
        email: identity.email,
        scope: getGoogleWorkspaceVerificationMarker(identity.hostedDomain),
      },
    });
  },
  async linkGoogleAccount(userId, identity) {
    await db.account.create({
      data: {
        userId,
        provider: 'google',
        providerId: identity.id,
        email: identity.email,
        scope: getGoogleWorkspaceVerificationMarker(identity.hostedDomain),
      },
    });
  },
  createGoogleUser(identity) {
    return db.user.create({
      data: {
        email: identity.email,
        firstName: identity.firstName,
        lastName: identity.lastName,
        accounts: {
          create: {
            provider: 'google',
            providerId: identity.id,
            email: identity.email,
            scope: getGoogleWorkspaceVerificationMarker(identity.hostedDomain),
          },
        },
      },
    });
  },
};

interface ValidatedOAuthQuery {
  code: string;
  state: string;
}

async function validateOAuthCallback(
  req: FastifyRequest,
): Promise<ValidatedOAuthQuery> {
  const schema = z.object({
    code: z.string(),
    state: z.string(),
  });

  const query = schema.safeParse(req.query);
  if (!query.success) {
    throw new LogError('Invalid callback query params', {
      error: query.error,
      provider: 'google',
    });
  }

  const { code, state } = query.data;
  const storedState = req.cookies.google_oauth_state ?? null;
  const codeVerifier = req.cookies.google_code_verifier ?? null;

  if (
    code === null ||
    state === null ||
    storedState === null ||
    codeVerifier === null
  ) {
    throw new LogError('Missing oauth parameters', {
      code: code === null,
      state: state === null,
      storedState: storedState === null,
      codeVerifier: codeVerifier === null,
      provider: 'google',
    });
  }

  if (state !== storedState) {
    throw new LogError('OAuth state mismatch', {
      provider: 'google',
    });
  }

  return { code, state };
}

export async function googleCallback(req: FastifyRequest, reply: FastifyReply) {
  try {
    const config = getGoogleAuthConfig();
    const google = getGoogleOAuthClient();
    const { code } = await validateOAuthCallback(req);
    const inviteId = req.cookies.inviteId;
    const codeVerifier = req.cookies.google_code_verifier!;
    const tokens = await google.validateAuthorizationCode(code, codeVerifier);
    const googleUser = await fetchGoogleUser(tokens, config.allowedDomains);
    const user = await resolveGoogleUserWithConflictRetry(
      googleUser,
      googleAccountRepository,
      (error) =>
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002',
    );

    reply.clearCookie('google_code_verifier');
    reply.clearCookie('google_oauth_state');

    if (inviteId) {
      try {
        await connectUserToOrganization({ user, inviteId });
      } catch (error) {
        req.log.error('OAuth invite failed', {
          error,
          inviteId,
          userId: user.id,
        });
      }
    }

    // No invite, or the invite failed: fall back to the default organization so
    // a verified colleague is not left staring at an empty dashboard. No-op
    // unless DEFAULT_ORGANIZATION_ID is set, and never touches existing members.
    try {
      await connectUserToDefaultOrganization({ user });
    } catch (error) {
      // Never block a valid sign-in on this.
      req.log.error('default organization join failed', {
        error,
        userId: user.id,
      });
    }

    const sessionToken = generateSessionToken();
    const session = await createSession(sessionToken, user.id);
    setSessionTokenCookie(
      (...args) => reply.setCookie(...args),
      sessionToken,
      session.expiresAt,
    );
    return reply.redirect(
      process.env.DASHBOARD_URL || process.env.NEXT_PUBLIC_DASHBOARD_URL!,
    );
  } catch (error) {
    req.log.error(error);
    return redirectWithError(reply, error);
  }
}

function redirectWithError(reply: FastifyReply, error: LogError | unknown) {
  const url = new URL(
    process.env.DASHBOARD_URL || process.env.NEXT_PUBLIC_DASHBOARD_URL!,
  );
  url.pathname = '/login';
  if (error instanceof LogError) {
    url.searchParams.set('error', error.message);
  } else {
    url.searchParams.set('error', 'An error occurred');
  }
  url.searchParams.set('correlationId', reply.request.id);
  return reply.redirect(url.toString());
}
