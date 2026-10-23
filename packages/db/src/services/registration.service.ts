import { db } from '../prisma-client';

/**
 * Whether a *new* user may be created right now.
 *
 * Only consult this once we know the account does not exist yet (e.g. in the
 * OAuth callback, not before the IdP redirect), otherwise returning users get
 * rejected too.
 *
 * - ALLOW_REGISTRATION unset: open registration.
 * - The very first user of an install is always allowed (bootstrap).
 * - Otherwise a valid invite is required when ALLOW_REGISTRATION=false: either
 *   the invite id they arrived with, or, for an email the identity provider
 *   verified, any unexpired invite addressed to it. When both are known the
 *   invite link must be addressed to that email, so a forwarded link cannot
 *   create an account for someone else.
 */
export async function getIsRegistrationAllowed({
  inviteId,
  verifiedEmail,
}: {
  inviteId?: string | null;
  verifiedEmail?: string | null;
} = {}) {
  if (process.env.ALLOW_REGISTRATION === undefined) {
    return true;
  }

  const count = await db.user.count();
  if (count === 0) {
    return true;
  }

  if (process.env.ALLOW_REGISTRATION !== 'false') {
    return true;
  }

  if (process.env.ALLOW_INVITATION === 'false') {
    return false;
  }

  if (inviteId) {
    const invite = await db.$primary().invite.findUnique({
      where: { id: inviteId },
    });
    if (
      invite &&
      invite.expiresAt > new Date() &&
      (!verifiedEmail ||
        invite.email.toLowerCase() === verifiedEmail.toLowerCase())
    ) {
      return true;
    }
  }

  if (verifiedEmail) {
    const invite = await db.$primary().invite.findFirst({
      where: {
        email: { equals: verifiedEmail, mode: 'insensitive' },
        expiresAt: { gt: new Date() },
      },
    });
    if (invite) {
      return true;
    }
  }

  return false;
}

/**
 * Organizations are created by the platform owner, never by end users. The
 * only exception is an empty install, so a fresh self-hosted or local setup
 * can create its first organization.
 */
export async function getIsOrganizationCreationAllowed() {
  const count = await db.organization.count();
  return count === 0;
}
