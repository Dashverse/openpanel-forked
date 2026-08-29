import crypto from 'node:crypto';
import { type Session, type User, db } from '@openpanel/db';
import { sha256 } from '@oslojs/crypto/sha2';
import {
  encodeBase32LowerCaseNoPadding,
  encodeHexLowerCase,
} from '@oslojs/encoding';
import { getGoogleAuthConfig, isEligibleGoogleUser } from './google-auth';
import { revalidateGoogleGrant } from './google-revalidation';

// How long a Google confirmation is trusted. This is the offboarding SLA: a
// suspended account keeps access for at most this long.
const revalidateAfterMs = () => {
  const minutes = Number(process.env.GOOGLE_REVALIDATE_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
};
// A session with no refresh token cannot be checked, so it must not survive.
// This is only a loop guard, not a grace period: dropping such a session the
// instant it appears would bounce a just-completed login between callback and
// login forever if Google ever withheld a token. Anything older than one login
// flow is safe to end, which costs pre-existing sessions a single re-login.
const unverifiedLoopGuardMs = () => {
  const minutes = Number(process.env.GOOGLE_UNVERIFIED_SESSION_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
};

export function generateSessionToken(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const token = encodeBase32LowerCaseNoPadding(bytes);
  return token;
}

export async function createSession(
  token: string,
  userId: string,
): Promise<Session> {
  const sessionId = encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
  const session: Session = {
    id: sessionId,
    userId,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    // The OAuth callback just verified this identity with Google.
    lastVerifiedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.session.create({
    data: session,
  });
  return session;
}

export const EMPTY_SESSION: SessionValidationResult = {
  session: null,
  user: null,
  userId: null,
};

export const decodeSessionToken = (token: string): string | null => {
  return token
    ? encodeHexLowerCase(sha256(new TextEncoder().encode(token)))
    : null;
};

export async function validateSessionToken(
  token: string | null | undefined,
): Promise<SessionValidationResult> {
  if (!token) {
    return EMPTY_SESSION;
  }
  const sessionId = decodeSessionToken(token);
  if (!sessionId) {
    return EMPTY_SESSION;
  }
  const result = await db.$primary().session.findUnique({
    where: {
      id: sessionId,
    },
    include: {
      user: {
        include: {
          accounts: {
            select: {
              provider: true,
              providerId: true,
              email: true,
              scope: true,
              refreshToken: true,
            },
          },
        },
      },
    },
  });
  if (result === null) {
    return EMPTY_SESSION;
  }
  const { accounts, ...user } = result.user;
  const { user: _user, ...session } = result;
  if (Date.now() >= session.expiresAt.getTime()) {
    await db.session.delete({ where: { id: sessionId } });
    return EMPTY_SESSION;
  }
  const { allowedDomain } = getGoogleAuthConfig();
  if (!isEligibleGoogleUser(user, accounts, allowedDomain)) {
    await db.session.delete({ where: { id: sessionId } });
    return EMPTY_SESSION;
  }

  // The check above reads columns written once, at sign-in, so on its own it
  // never notices a Google account being suspended or deleted. Re-confirm with
  // Google periodically, server to server — no redirect, nothing the user sees.
  const now = Date.now();
  const verifiedAgeMs = now - (session.lastVerifiedAt?.getTime() ?? 0);
  if (verifiedAgeMs >= revalidateAfterMs()) {
    const outcome = await revalidateGoogleGrant(
      accounts.find((a) => a.provider === 'google' && a.refreshToken)
        ?.refreshToken,
    );
    const unverifiableTooLong =
      outcome === 'unverifiable' &&
      now - session.createdAt.getTime() >= unverifiedLoopGuardMs();

    if (outcome === 'revoked' || unverifiableTooLong) {
      await db.session.delete({ where: { id: sessionId } });
      return EMPTY_SESSION;
    }

    // 'unavailable' also refreshes the timestamp: a Google outage must not add
    // a failing round-trip to every request. It costs one interval of trust.
    session.lastVerifiedAt = new Date(now);
    await db.session.update({
      where: { id: sessionId },
      data: { lastVerifiedAt: session.lastVerifiedAt },
    });
  }
  if (Date.now() >= session.expiresAt.getTime() - 1000 * 60 * 60 * 24 * 15) {
    session.expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
    await db.session.update({
      where: {
        id: session.id,
      },
      data: {
        expiresAt: session.expiresAt,
      },
    });
  }
  return { session, user, userId: user.id };
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await db.session.delete({ where: { id: sessionId } });
}

export type SessionValidationResult =
  | { session: Session; user: User; userId: string }
  | { session: null; user: null; userId: null };
