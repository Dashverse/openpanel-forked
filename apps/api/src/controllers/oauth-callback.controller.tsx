import { LogError } from '@/utils/errors';
import {
  Arctic,
  DomainPolicyError,
  type GoogleIdentity,
  type OAuth2Tokens,
  createSession,
  describeAllowedDomains,
  generateSessionToken,
  github,
  google,
  isEmailDomainAllowed,
  isGithubLoginEnabled,
  parseGoogleIdentity,
  setSessionTokenCookie,
} from '@openpanel/auth';
import {
  type Account,
  type User,
  claimPendingInvitesForUser,
  connectUserToOrganization,
  db,
  getIsRegistrationAllowed,
} from '@openpanel/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

async function getGithubEmail(githubAccessToken: string) {
  const emailListRequest = new Request('https://api.github.com/user/emails');
  emailListRequest.headers.set('Authorization', `Bearer ${githubAccessToken}`);
  const emailListResponse = await fetch(emailListRequest);
  const emailListResult: unknown = await emailListResponse.json();
  if (!Array.isArray(emailListResult) || emailListResult.length < 1) {
    return null;
  }
  let email: string | null = null;
  for (const emailRecord of emailListResult) {
    const emailParser = z.object({
      primary: z.boolean(),
      verified: z.boolean(),
      email: z.string(),
    });
    const emailResult = emailParser.safeParse(emailRecord);
    if (!emailResult.success) {
      continue;
    }
    if (emailResult.data.primary && emailResult.data.verified) {
      email = emailResult.data.email;
    }
  }
  return email;
}

// New types and interfaces
type Provider = 'github' | 'google';
interface OAuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName?: string;
}

// Shared utility functions
const NO_INVITE_MESSAGE =
  'You need an invite to access OpenPanel. Ask an admin to invite you.';

/**
 * Best-effort: join the organizations this user was invited to. A broken or
 * expired invite must never block an otherwise valid sign-in.
 */
async function redeemInvites({
  user,
  inviteId,
  claimByEmail,
  reply,
}: {
  user: User;
  inviteId: string | undefined | null;
  claimByEmail: boolean;
  reply: FastifyReply;
}) {
  if (inviteId) {
    try {
      await connectUserToOrganization({ user, inviteId });
    } catch (error) {
      reply.log.warn(
        { error, inviteId, userId: user.id },
        'could not redeem invite from link',
      );
    }
    reply.clearCookie('inviteId');
  }

  if (claimByEmail) {
    const { failed } = await claimPendingInvitesForUser(user);
    for (const { inviteId, error } of failed) {
      reply.log.warn(
        { error, inviteId, userId: user.id },
        'could not redeem pending invite',
      );
    }
  }
}

async function handleExistingUser({
  account,
  oauthUser,
  providerName,
  inviteId,
  reply,
}: {
  account: Account;
  oauthUser: OAuthUser;
  providerName: Provider;
  inviteId: string | undefined | null;
  reply: FastifyReply;
}) {
  const sessionToken = generateSessionToken();
  const session = await createSession(sessionToken, account.userId);

  await db.account.update({
    where: { id: account.id },
    data: {
      provider: providerName,
      providerId: oauthUser.id,
      email: oauthUser.email,
    },
  });

  if (inviteId) {
    const user = await db.user.findUniqueOrThrow({
      where: { id: account.userId },
    });
    await redeemInvites({ user, inviteId, claimByEmail: false, reply });
  }

  setSessionTokenCookie(
    (...args) => reply.setCookie(...args),
    sessionToken,
    session.expiresAt,
  );
  return reply.redirect(
    process.env.DASHBOARD_URL || process.env.NEXT_PUBLIC_DASHBOARD_URL!,
  );
}

async function handleNewUser({
  oauthUser,
  providerName,
  inviteId,
  reply,
}: {
  oauthUser: OAuthUser;
  providerName: Provider;
  inviteId: string | undefined | null;
  reply: FastifyReply;
}) {
  const existingUser = await db.user.findFirst({
    where: { email: oauthUser.email },
  });

  if (existingUser) {
    throw new LogError(
      'Please sign in using your original authentication method',
      {
        existingUser,
        oauthUser,
        providerName,
      },
    );
  }

  // Enforced here rather than before the IdP redirect: this is the first point
  // where we know the person is new, so returning users are never caught by
  // it. No profile data in the log payload, the person is not a user.
  // GitHub only hands us a verified primary email (getGithubEmail)
  if (
    !(await getIsRegistrationAllowed({
      inviteId,
      verifiedEmail: oauthUser.email,
    }))
  ) {
    throw new LogError(NO_INVITE_MESSAGE, { providerName, inviteId });
  }

  const user = await db.user.create({
    data: {
      email: oauthUser.email,
      firstName: oauthUser.firstName,
      lastName: oauthUser.lastName,
      accounts: {
        create: {
          provider: providerName,
          providerId: oauthUser.id,
        },
      },
    },
  });

  await redeemInvites({ user, inviteId, claimByEmail: false, reply });

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
}

// Provider-specific user fetching
async function fetchGithubUser(accessToken: string): Promise<OAuthUser> {
  const email = await getGithubEmail(accessToken);
  if (!email) {
    throw new LogError('GitHub email not found or not verified');
  }

  const userRequest = new Request('https://api.github.com/user');
  userRequest.headers.set('Authorization', `Bearer ${accessToken}`);
  const userResponse = await fetch(userRequest);

  const userSchema = z.object({
    id: z.number(),
    login: z.string(),
    name: z
      .string()
      .nullish()
      .transform((val) => val || ''),
  });
  const userJson = await userResponse.json();

  const userResult = userSchema.safeParse(userJson);
  if (!userResult.success) {
    throw new LogError('Error fetching Github user', {
      error: userResult.error,
      githubUser: userJson,
    });
  }

  return {
    id: String(userResult.data.id),
    email,
    firstName: userResult.data.name || userResult.data.login || '',
  };
}

function getGoogleIdentity(tokens: OAuth2Tokens): GoogleIdentity {
  try {
    return parseGoogleIdentity(Arctic.decodeIdToken(tokens.idToken()));
  } catch (error) {
    if (error instanceof DomainPolicyError) {
      throw new LogError(error.message);
    }
    throw error;
  }
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Find or create the user behind a verified Google identity.
 *
 * 1. An account already bound to this Google id.
 * 2. A legacy Google/OAuth account matched by email, which gets bound now.
 * 3. An existing user with this email (e.g. an email/password account): link
 *    Google to it. Safe because Google verified the address and, with an
 *    allow-list configured, that it belongs to our Workspace.
 * 4. A brand-new user, only when registration is allowed for them.
 */
async function resolveGoogleUser(
  identity: GoogleIdentity,
  inviteId: string | undefined | null,
): Promise<User> {
  const account = await db.account.findFirst({
    where: {
      OR: [
        { provider: 'google', providerId: identity.id },
        {
          provider: 'google',
          providerId: null,
          user: { email: { equals: identity.email, mode: 'insensitive' } },
        },
        {
          provider: 'oauth',
          user: { email: { equals: identity.email, mode: 'insensitive' } },
        },
      ],
    },
    // Prefer the account already bound to this exact Google id
    orderBy: { providerId: { sort: 'asc', nulls: 'last' } },
    include: { user: true },
  });

  if (account) {
    await db.account.update({
      where: { id: account.id },
      data: {
        provider: 'google',
        providerId: identity.id,
        email: identity.email,
      },
    });
    return account.user;
  }

  const existingUser = await db.user.findFirst({
    where: { email: { equals: identity.email, mode: 'insensitive' } },
  });

  if (existingUser) {
    try {
      await db.account.create({
        data: {
          userId: existingUser.id,
          provider: 'google',
          providerId: identity.id,
          email: identity.email,
        },
      });
    } catch (error) {
      // A concurrent sign-in linked it first
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
    return existingUser;
  }

  const isRegistrationAllowed = await getIsRegistrationAllowed({
    inviteId,
    verifiedEmail: identity.email,
  });
  if (!isRegistrationAllowed) {
    throw new LogError(NO_INVITE_MESSAGE, { providerName: 'google', inviteId });
  }

  try {
    return await db.user.create({
      data: {
        email: identity.email,
        firstName: identity.firstName,
        lastName: identity.lastName,
        accounts: {
          create: {
            provider: 'google',
            providerId: identity.id,
            email: identity.email,
          },
        },
      },
    });
  } catch (error) {
    // A concurrent first sign-in created the user first
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    return db.user.findFirstOrThrow({
      where: { email: { equals: identity.email, mode: 'insensitive' } },
    });
  }
}

interface ValidatedOAuthQuery {
  code: string;
  state: string;
}

async function validateOAuthCallback(
  req: FastifyRequest,
  provider: Provider,
): Promise<ValidatedOAuthQuery> {
  const schema = z.object({
    code: z.string(),
    state: z.string(),
  });

  const query = schema.safeParse(req.query);
  if (!query.success) {
    throw new LogError('Invalid callback query params', {
      error: query.error,
      query: req.query,
      provider,
    });
  }

  const { code, state } = query.data;
  const storedState = req.cookies[`${provider}_oauth_state`] ?? null;
  const codeVerifier =
    provider === 'google' ? (req.cookies.google_code_verifier ?? null) : null;

  if (
    code === null ||
    state === null ||
    storedState === null ||
    (provider === 'google' && codeVerifier === null)
  ) {
    throw new LogError('Missing oauth parameters', {
      code: code === null,
      state: state === null,
      storedState: storedState === null,
      codeVerifier: provider === 'google' ? codeVerifier === null : undefined,
      provider,
    });
  }

  if (state !== storedState) {
    throw new LogError('OAuth state mismatch', {
      state,
      storedState,
      provider,
    });
  }

  return { code, state };
}

// Main callback handlers
export async function githubCallback(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { code } = await validateOAuthCallback(req, 'github');
    const inviteId = req.cookies.inviteId;
    const tokens = await github.validateAuthorizationCode(code);
    const githubUser = await fetchGithubUser(tokens.accessToken());
    // Belt and braces: signInOAuth already refuses GitHub with an allow-list
    if (!isGithubLoginEnabled() || !isEmailDomainAllowed(githubUser.email)) {
      throw new LogError(
        `Sign in with your ${describeAllowedDomains()} Google account`,
      );
    }
    const account = await db.account.findFirst({
      where: {
        OR: [
          // To keep
          { provider: 'github', providerId: githubUser.id },
          // During migration
          { provider: 'github', providerId: null, email: githubUser.email },
          { provider: 'oauth', user: { email: githubUser.email } },
        ],
      },
    });

    reply.clearCookie('github_oauth_state');

    if (account) {
      return await handleExistingUser({
        account,
        oauthUser: githubUser,
        providerName: 'github',
        inviteId,
        reply,
      });
    }

    return await handleNewUser({
      oauthUser: githubUser,
      providerName: 'github',
      inviteId,
      reply,
    });
  } catch (error) {
    req.log.error(error);
    return redirectWithError(reply, error);
  }
}

export async function googleCallback(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { code } = await validateOAuthCallback(req, 'google');
    const inviteId = req.cookies.inviteId;
    const codeVerifier = req.cookies.google_code_verifier!;
    reply.clearCookie('google_code_verifier');
    reply.clearCookie('google_oauth_state');

    const tokens = await google.validateAuthorizationCode(code, codeVerifier);
    const identity = getGoogleIdentity(tokens);
    const user = await resolveGoogleUser(identity, inviteId);

    // Google verified this email, so pending invites addressed to it can be
    // redeemed without the person ever clicking the invite link.
    await redeemInvites({ user, inviteId, claimByEmail: true, reply });

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
