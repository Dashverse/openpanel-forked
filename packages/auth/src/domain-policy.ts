/**
 * Which email domains may use the dashboard.
 *
 * GOOGLE_ALLOWED_DOMAIN holds a single domain or a comma-separated list
 * (e.g. "dashverse.ai,dashtoon.com"). When it is unset or empty there is no
 * restriction, which keeps local development and fresh installs working.
 */

type Env = Record<string, string | undefined>;

const normalizeDomain = (domain: string) => domain.trim().toLowerCase();

export function parseAllowedDomains(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const domains = value.split(',').map(normalizeDomain).filter(Boolean);
  return [...new Set(domains)];
}

export function getAllowedEmailDomains(
  env: Env = process.env as Env,
): string[] {
  return parseAllowedDomains(env.GOOGLE_ALLOWED_DOMAIN);
}

export function getEmailDomain(email: string): string {
  const normalized = email.trim().toLowerCase();
  const separator = normalized.lastIndexOf('@');
  return separator > 0 ? normalized.slice(separator + 1) : '';
}

export function isEmailDomainAllowed(
  email: string,
  allowedDomains: string[] = getAllowedEmailDomains(),
): boolean {
  if (allowedDomains.length === 0) {
    return true;
  }
  return allowedDomains.includes(getEmailDomain(email));
}

export function describeAllowedDomains(
  allowedDomains: string[] = getAllowedEmailDomains(),
): string {
  return allowedDomains.map((domain) => `@${domain}`).join(' or ');
}

export class DomainPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainPolicyError';
  }
}

export interface GoogleIdentity {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

/**
 * Validate the claims of a Google ID token.
 *
 * With an allow-list configured, the signed `hd` (Workspace hosted domain)
 * claim must be allow-listed AND the email must belong to that same domain.
 * Consumer Gmail accounts carry no `hd` claim and are rejected. Comparing the
 * email to "any allowed domain" instead would let an allowed `hd` vouch for an
 * address on a different domain.
 */
export function parseGoogleIdentity(
  claims: unknown,
  allowedDomains: string[] = getAllowedEmailDomains(),
): GoogleIdentity {
  const data = (claims ?? {}) as Record<string, unknown>;
  const id = typeof data.sub === 'string' ? data.sub : '';
  const email =
    typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';

  if (!id || !email) {
    throw new DomainPolicyError('Google did not return an email address');
  }

  if (data.email_verified !== true) {
    throw new DomainPolicyError('Email not verified with Google');
  }

  if (allowedDomains.length > 0) {
    const hostedDomain =
      typeof data.hd === 'string' ? normalizeDomain(data.hd) : '';
    if (
      !allowedDomains.includes(hostedDomain) ||
      getEmailDomain(email) !== hostedDomain
    ) {
      throw new DomainPolicyError(
        `Sign in with your ${describeAllowedDomains(allowedDomains)} Google account`,
      );
    }
  }

  return {
    id,
    email,
    firstName: typeof data.given_name === 'string' ? data.given_name : '',
    lastName: typeof data.family_name === 'string' ? data.family_name : '',
  };
}

/**
 * Whether email/password sign-in, sign-up and reset are available.
 *
 * With a Google Workspace allow-list configured everyone allowed in has a
 * Google account, so passwords are off: one less way in to guess at.
 * ALLOW_PASSWORD_LOGIN=true turns them back on (break-glass if Google sign-in
 * is unavailable); without an allow-list (local dev, self-hosting) they stay
 * on so an install without Google OAuth still works.
 */
export function isPasswordLoginEnabled(env: Env = process.env as Env): boolean {
  if (
    env.ALLOW_PASSWORD_LOGIN !== undefined &&
    env.ALLOW_PASSWORD_LOGIN !== ''
  ) {
    return env.ALLOW_PASSWORD_LOGIN === 'true';
  }
  return getAllowedEmailDomains(env).length === 0;
}

/**
 * Whether new accounts may be created with a password.
 *
 * Never with a Workspace allow-list: a password sign-up trusts a typed email,
 * so whoever holds an invite link could create the invitee's account with
 * their own password, and Google would later link into it. The
 * ALLOW_PASSWORD_LOGIN break-glass only restores sign-in for existing users.
 */
export function isPasswordSignUpEnabled(
  env: Env = process.env as Env,
): boolean {
  return (
    getAllowedEmailDomains(env).length === 0 && isPasswordLoginEnabled(env)
  );
}

/**
 * GitHub sign-in proves nothing about Workspace membership, and a GitHub
 * email stays verified after someone leaves the company, so it is unavailable
 * whenever a Workspace allow-list is configured.
 */
export function isGithubLoginEnabled(env: Env = process.env as Env): boolean {
  return getAllowedEmailDomains(env).length === 0 && !!env.GITHUB_CLIENT_ID;
}
