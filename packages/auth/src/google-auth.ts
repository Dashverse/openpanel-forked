export class GoogleAuthPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthPolicyError';
  }
}

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedDomains: string[];
}

export interface GoogleIdentity {
  id: string;
  email: string;
  hostedDomain: string;
  firstName: string;
  lastName: string;
}

interface GoogleAccountIdentity {
  provider: string;
  providerId: string | null;
  email: string | null;
  scope: string | null;
}

type GoogleAuthEnvironment = Record<string, string | undefined>;

const requiredSecrets = [
  ['GOOGLE_CLIENT_ID', 'clientId'],
  ['GOOGLE_CLIENT_SECRET', 'clientSecret'],
  ['GOOGLE_REDIRECT_URI', 'redirectUri'],
] as const;

const normalizeDomain = (domain: string) => domain.trim().toLowerCase();

// GOOGLE_ALLOWED_DOMAIN accepts a single domain or a comma-separated list.
export const parseAllowedDomains = (value: string): string[] => {
  const domains = value.split(',').map(normalizeDomain).filter(Boolean);
  return [...new Set(domains)];
};

export const getGoogleWorkspaceVerificationMarker = (domain: string) =>
  `workspace-verified:${normalizeDomain(domain)}`;

const getEmailDomain = (email: string) => {
  const separator = email.lastIndexOf('@');
  return separator > 0 ? email.slice(separator + 1).toLowerCase() : '';
};

const describeDomains = (domains: string[]) =>
  domains.map((domain) => `@${domain}`).join(' or ');

export function getGoogleAuthConfig(
  env: GoogleAuthEnvironment = process.env as GoogleAuthEnvironment,
): GoogleAuthConfig {
  const config: Partial<GoogleAuthConfig> = {};

  for (const [envKey, configKey] of requiredSecrets) {
    const value = env[envKey]?.trim();
    if (!value) {
      throw new GoogleAuthPolicyError(
        `Missing Google OAuth configuration: ${envKey}`,
      );
    }
    config[configKey] = value;
  }

  const allowedDomains = parseAllowedDomains(
    env.GOOGLE_ALLOWED_DOMAIN?.trim() ?? '',
  );
  if (allowedDomains.length === 0) {
    throw new GoogleAuthPolicyError(
      'Missing Google OAuth configuration: GOOGLE_ALLOWED_DOMAIN',
    );
  }
  config.allowedDomains = allowedDomains;

  return config as GoogleAuthConfig;
}

export function assertGoogleOnlyAuthRuntime(
  env: GoogleAuthEnvironment = process.env as GoogleAuthEnvironment,
): GoogleAuthConfig {
  const config = getGoogleAuthConfig(env);
  if (env.DEMO_USER_ID?.trim()) {
    throw new GoogleAuthPolicyError(
      'DEMO_USER_ID must be unset when Google-only authentication is enabled',
    );
  }
  return config;
}

export function parseGoogleIdentity(
  claims: unknown,
  configuredDomains: string[],
): GoogleIdentity {
  const allowedDomains = configuredDomains.map(normalizeDomain);
  const data = claims as Record<string, unknown> | null;
  const id = typeof data?.sub === 'string' ? data.sub : '';
  const email =
    typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
  const hostedDomain =
    typeof data?.hd === 'string' ? normalizeDomain(data.hd) : '';

  // The hosted domain must be allow-listed, and the email must belong to that
  // same domain — never merely to some other allowed one.
  if (
    !id ||
    data?.email_verified !== true ||
    !allowedDomains.includes(hostedDomain) ||
    getEmailDomain(email) !== hostedDomain
  ) {
    throw new GoogleAuthPolicyError(
      `Use your ${describeDomains(allowedDomains)} Google Workspace account`,
    );
  }

  return {
    id,
    email,
    hostedDomain,
    firstName: typeof data?.given_name === 'string' ? data.given_name : '',
    lastName: typeof data?.family_name === 'string' ? data.family_name : '',
  };
}

export function isEligibleGoogleUser(
  user: { email: string },
  accounts: GoogleAccountIdentity[],
  configuredDomains: string[],
): boolean {
  const allowedDomains = configuredDomains.map(normalizeDomain);
  const userDomain = getEmailDomain(user.email.trim().toLowerCase());
  if (!allowedDomains.includes(userDomain)) {
    return false;
  }

  return accounts.some((account) => {
    if (
      account.provider !== 'google' ||
      typeof account.providerId !== 'string' ||
      account.providerId.length === 0 ||
      typeof account.email !== 'string'
    ) {
      return false;
    }
    const accountDomain = getEmailDomain(account.email.trim().toLowerCase());
    return (
      allowedDomains.includes(accountDomain) &&
      account.scope === getGoogleWorkspaceVerificationMarker(accountDomain)
    );
  });
}
