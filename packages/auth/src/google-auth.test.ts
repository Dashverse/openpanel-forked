import { describe, expect, it } from 'vitest';
import {
  GoogleAuthPolicyError,
  getGoogleAuthConfig,
  getGoogleWorkspaceVerificationMarker,
  isEligibleGoogleUser,
  parseAllowedDomains,
  parseGoogleIdentity,
} from './google-auth';

const claims = (over: Record<string, unknown> = {}) => ({
  sub: 'google-123',
  email: 'someone@dashverse.ai',
  email_verified: true,
  hd: 'dashverse.ai',
  given_name: 'Some',
  family_name: 'One',
  ...over,
});

const account = (over: Record<string, unknown> = {}) => ({
  provider: 'google',
  providerId: 'google-123',
  email: 'someone@dashverse.ai',
  scope: getGoogleWorkspaceVerificationMarker('dashverse.ai'),
  ...over,
});

describe('parseAllowedDomains', () => {
  it('parses a single domain', () => {
    expect(parseAllowedDomains('dashverse.ai')).toEqual(['dashverse.ai']);
  });

  it('parses a comma-separated list, trimming and lowercasing', () => {
    expect(parseAllowedDomains(' Dashverse.ai , DASHTOON.com ')).toEqual([
      'dashverse.ai',
      'dashtoon.com',
    ]);
  });

  it('drops blanks and duplicates', () => {
    expect(parseAllowedDomains('a.com,,a.com, b.com,')).toEqual([
      'a.com',
      'b.com',
    ]);
  });

  it('returns an empty list for an empty value', () => {
    expect(parseAllowedDomains('   ')).toEqual([]);
  });
});

describe('getGoogleAuthConfig', () => {
  const env = {
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REDIRECT_URI: 'https://example.com/api/oauth/google/callback',
  };

  it('accepts a single domain', () => {
    expect(
      getGoogleAuthConfig({ ...env, GOOGLE_ALLOWED_DOMAIN: 'dashverse.ai' })
        .allowedDomains,
    ).toEqual(['dashverse.ai']);
  });

  it('accepts several domains', () => {
    expect(
      getGoogleAuthConfig({
        ...env,
        GOOGLE_ALLOWED_DOMAIN: 'dashverse.ai,dashtoon.com',
      }).allowedDomains,
    ).toEqual(['dashverse.ai', 'dashtoon.com']);
  });

  it('throws when the domain list is missing or blank', () => {
    expect(() => getGoogleAuthConfig(env)).toThrow(GoogleAuthPolicyError);
    expect(() =>
      getGoogleAuthConfig({ ...env, GOOGLE_ALLOWED_DOMAIN: ' , ' }),
    ).toThrow(/GOOGLE_ALLOWED_DOMAIN/);
  });
});

describe('parseGoogleIdentity', () => {
  const allowed = ['dashverse.ai', 'dashtoon.com'];

  it('accepts a workspace account on any allowed domain', () => {
    expect(parseGoogleIdentity(claims(), allowed).email).toBe(
      'someone@dashverse.ai',
    );
    expect(
      parseGoogleIdentity(
        claims({ email: 'other@dashtoon.com', hd: 'dashtoon.com' }),
        allowed,
      ).hostedDomain,
    ).toBe('dashtoon.com');
  });

  it('lowercases the email', () => {
    expect(
      parseGoogleIdentity(claims({ email: 'Someone@Dashverse.ai' }), allowed)
        .email,
    ).toBe('someone@dashverse.ai');
  });

  it('rejects a domain that is not allow-listed', () => {
    expect(() =>
      parseGoogleIdentity(
        claims({ email: 'a@gmail.com', hd: 'gmail.com' }),
        allowed,
      ),
    ).toThrow(GoogleAuthPolicyError);
  });

  it('rejects a consumer account with no hd claim', () => {
    expect(() =>
      parseGoogleIdentity(claims({ hd: undefined, email: 'a@gmail.com' }), allowed),
    ).toThrow(GoogleAuthPolicyError);
  });

  it('rejects an unverified email', () => {
    expect(() =>
      parseGoogleIdentity(claims({ email_verified: false }), allowed),
    ).toThrow(GoogleAuthPolicyError);
  });

  it('rejects when the email domain does not match its own hd claim', () => {
    // Both domains are allowed, but the pair is inconsistent.
    expect(() =>
      parseGoogleIdentity(
        claims({ email: 'a@dashtoon.com', hd: 'dashverse.ai' }),
        allowed,
      ),
    ).toThrow(GoogleAuthPolicyError);
  });

  it('names every allowed domain in the error', () => {
    expect(() =>
      parseGoogleIdentity(claims({ hd: 'nope.com', email: 'a@nope.com' }), allowed),
    ).toThrow(/@dashverse\.ai or @dashtoon\.com/);
  });
});

describe('isEligibleGoogleUser', () => {
  const allowed = ['dashverse.ai', 'dashtoon.com'];
  const user = { email: 'someone@dashverse.ai' };

  it('accepts a verified google account on an allowed domain', () => {
    expect(isEligibleGoogleUser(user, [account()], allowed)).toBe(true);
  });

  it('accepts a second allowed domain with its own marker', () => {
    expect(
      isEligibleGoogleUser(
        { email: 'other@dashtoon.com' },
        [
          account({
            email: 'other@dashtoon.com',
            scope: getGoogleWorkspaceVerificationMarker('dashtoon.com'),
          }),
        ],
        allowed,
      ),
    ).toBe(true);
  });

  it('rejects a marker minted for a different domain', () => {
    expect(
      isEligibleGoogleUser(
        { email: 'other@dashtoon.com' },
        [
          account({
            email: 'other@dashtoon.com',
            scope: getGoogleWorkspaceVerificationMarker('dashverse.ai'),
          }),
        ],
        allowed,
      ),
    ).toBe(false);
  });

  it('rejects a user whose email is off the allow-list', () => {
    expect(isEligibleGoogleUser({ email: 'a@gmail.com' }, [account()], allowed)).toBe(
      false,
    );
  });

  it('rejects legacy email/password accounts', () => {
    expect(
      isEligibleGoogleUser(
        user,
        [{ provider: 'email', providerId: null, email: null, scope: null }],
        allowed,
      ),
    ).toBe(false);
  });

  it('rejects a google account with no providerId', () => {
    expect(
      isEligibleGoogleUser(user, [account({ providerId: null })], allowed),
    ).toBe(false);
  });

  it('rejects a google account with no verification marker', () => {
    expect(isEligibleGoogleUser(user, [account({ scope: null })], allowed)).toBe(
      false,
    );
  });
});
