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
  allowedDomain: string;
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

const requiredConfig = [
  ['GOOGLE_CLIENT_ID', 'clientId'],
  ['GOOGLE_CLIENT_SECRET', 'clientSecret'],
  ['GOOGLE_REDIRECT_URI', 'redirectUri'],
  ['GOOGLE_ALLOWED_DOMAIN', 'allowedDomain'],
] as const;

const normalizeDomain = (domain: string) => domain.trim().toLowerCase();

export const getGoogleWorkspaceVerificationMarker = (domain: string) =>
  `workspace-verified:${normalizeDomain(domain)}`;

const getEmailDomain = (email: string) => {
  const separator = email.lastIndexOf('@');
  return separator > 0 ? email.slice(separator + 1).toLowerCase() : '';
};

export function getGoogleAuthConfig(
  env: GoogleAuthEnvironment = process.env as GoogleAuthEnvironment,
): GoogleAuthConfig {
  const config: Partial<GoogleAuthConfig> = {};

  for (const [envKey, configKey] of requiredConfig) {
    const value = env[envKey]?.trim();
    if (!value) {
      throw new GoogleAuthPolicyError(
        `Missing Google OAuth configuration: ${envKey}`,
      );
    }
    config[configKey] =
      configKey === 'allowedDomain' ? normalizeDomain(value) : value;
  }

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
  configuredDomain: string,
): GoogleIdentity {
  const allowedDomain = normalizeDomain(configuredDomain);
  const data = claims as Record<string, unknown> | null;
  const id = typeof data?.sub === 'string' ? data.sub : '';
  const email =
    typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
  const hostedDomain =
    typeof data?.hd === 'string' ? normalizeDomain(data.hd) : '';

  if (
    !id ||
    data?.email_verified !== true ||
    hostedDomain !== allowedDomain ||
    getEmailDomain(email) !== allowedDomain
  ) {
    throw new GoogleAuthPolicyError(
      `Use your @${allowedDomain} Google Workspace account`,
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
  configuredDomain: string,
): boolean {
  const allowedDomain = normalizeDomain(configuredDomain);
  const verificationMarker =
    getGoogleWorkspaceVerificationMarker(allowedDomain);
  if (getEmailDomain(user.email.trim().toLowerCase()) !== allowedDomain) {
    return false;
  }

  return accounts.some(
    (account) =>
      account.provider === 'google' &&
      typeof account.providerId === 'string' &&
      account.providerId.length > 0 &&
      typeof account.email === 'string' &&
      getEmailDomain(account.email.trim().toLowerCase()) === allowedDomain &&
      account.scope === verificationMarker,
  );
}
