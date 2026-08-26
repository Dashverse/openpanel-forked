import { describe, expect, it } from 'vitest';
import {
  GoogleAuthPolicyError,
  assertGoogleOnlyAuthRuntime,
  getGoogleAuthConfig,
  isEligibleGoogleUser,
  parseGoogleIdentity,
} from './google-auth';

const validClaims = {
  sub: 'google-user-123',
  email: 'person@dashverse.ai',
  email_verified: true,
  hd: 'dashverse.ai',
  given_name: 'Dash',
  family_name: 'User',
};

describe('getGoogleAuthConfig', () => {
  it('normalizes the configured allowed domain', () => {
    expect(
      getGoogleAuthConfig({
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_CLIENT_SECRET: 'client-secret',
        GOOGLE_REDIRECT_URI: 'http://localhost:3333/oauth/google/callback',
        GOOGLE_ALLOWED_DOMAIN: ' Dashverse.AI ',
      }),
    ).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://localhost:3333/oauth/google/callback',
      allowedDomain: 'dashverse.ai',
    });
  });

  it.each([
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'GOOGLE_ALLOWED_DOMAIN',
  ] as const)('fails closed when %s is missing', (missingKey) => {
    const env: Record<string, string> = {
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
      GOOGLE_REDIRECT_URI: 'http://localhost:3333/oauth/google/callback',
      GOOGLE_ALLOWED_DOMAIN: 'dashverse.ai',
    };
    delete env[missingKey];

    expect(() => getGoogleAuthConfig(env)).toThrow(
      new GoogleAuthPolicyError(
        `Missing Google OAuth configuration: ${missingKey}`,
      ),
    );
  });
});

describe('assertGoogleOnlyAuthRuntime', () => {
  it('rejects demo-session configuration', () => {
    expect(() =>
      assertGoogleOnlyAuthRuntime({
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_CLIENT_SECRET: 'client-secret',
        GOOGLE_REDIRECT_URI: 'http://localhost:3333/oauth/google/callback',
        GOOGLE_ALLOWED_DOMAIN: 'dashverse.ai',
        DEMO_USER_ID: 'demo-user',
      }),
    ).toThrow(
      new GoogleAuthPolicyError(
        'DEMO_USER_ID must be unset when Google-only authentication is enabled',
      ),
    );
  });
});

describe('parseGoogleIdentity', () => {
  it('accepts a verified Dashverse Workspace identity', () => {
    expect(parseGoogleIdentity(validClaims, 'dashverse.ai')).toEqual({
      id: 'google-user-123',
      email: 'person@dashverse.ai',
      hostedDomain: 'dashverse.ai',
      firstName: 'Dash',
      lastName: 'User',
    });
  });

  it('normalizes claim casing before enforcing the domain', () => {
    expect(
      parseGoogleIdentity(
        { ...validClaims, email: 'Person@Dashverse.AI', hd: 'Dashverse.AI' },
        'DASHVERSE.AI',
      ).email,
    ).toBe('person@dashverse.ai');
  });

  it.each([
    [{ ...validClaims, hd: 'gmail.com' }, 'wrong hosted domain'],
    [
      { ...validClaims, hd: undefined },
      'consumer account without a hosted domain',
    ],
    [{ ...validClaims, email: 'person@example.com' }, 'wrong email domain'],
    [
      { ...validClaims, email: 'person@dashverse.ai.example.com' },
      'suffix-confusion email domain',
    ],
    [{ ...validClaims, email_verified: false }, 'unverified email'],
  ])('rejects %s (%s)', (claims, _description) => {
    expect(() => parseGoogleIdentity(claims, 'dashverse.ai')).toThrow(
      new GoogleAuthPolicyError(
        'Use your @dashverse.ai Google Workspace account',
      ),
    );
  });
});

describe('isEligibleGoogleUser', () => {
  it('accepts a Dashverse user linked to Google', () => {
    expect(
      isEligibleGoogleUser(
        { email: 'person@dashverse.ai' },
        [
          {
            provider: 'google',
            providerId: 'google-123',
            email: 'person@dashverse.ai',
            scope: 'workspace-verified:dashverse.ai',
          },
        ],
        'dashverse.ai',
      ),
    ).toBe(true);
  });

  it('rejects a legacy-only Dashverse user', () => {
    expect(
      isEligibleGoogleUser(
        { email: 'person@dashverse.ai' },
        [
          {
            provider: 'email',
            providerId: null,
            email: 'person@dashverse.ai',
            scope: null,
          },
        ],
        'dashverse.ai',
      ),
    ).toBe(false);
  });

  it('rejects a Google user outside Dashverse', () => {
    expect(
      isEligibleGoogleUser(
        { email: 'person@example.com' },
        [
          {
            provider: 'google',
            providerId: 'google-123',
            email: 'person@example.com',
            scope: 'workspace-verified:dashverse.ai',
          },
        ],
        'dashverse.ai',
      ),
    ).toBe(false);
  });

  it('rejects an unlinked Google migration placeholder', () => {
    expect(
      isEligibleGoogleUser(
        { email: 'person@dashverse.ai' },
        [
          {
            provider: 'google',
            providerId: null,
            email: 'person@dashverse.ai',
            scope: null,
          },
        ],
        'dashverse.ai',
      ),
    ).toBe(false);
  });

  it('rejects a historical Google account without Workspace verification', () => {
    expect(
      isEligibleGoogleUser(
        { email: 'person@dashverse.ai' },
        [
          {
            provider: 'google',
            providerId: 'google-123',
            email: 'person@dashverse.ai',
            scope: null,
          },
        ],
        'dashverse.ai',
      ),
    ).toBe(false);
  });
});
