import { describe, expect, it } from 'vitest';
import {
  DomainPolicyError,
  getEmailDomain,
  isEmailDomainAllowed,
  isGithubLoginEnabled,
  isPasswordLoginEnabled,
  isPasswordSignUpEnabled,
  parseAllowedDomains,
  parseGoogleIdentity,
} from './domain-policy';

const ALLOWED = ['dashverse.ai', 'dashtoon.com'];

const claims = (overrides: Record<string, unknown> = {}) => ({
  sub: 'google-sub-1',
  email: 'Jane@Dashverse.ai',
  email_verified: true,
  hd: 'dashverse.ai',
  given_name: 'Jane',
  family_name: 'Doe',
  ...overrides,
});

describe('parseAllowedDomains', () => {
  it('returns an empty list when unset', () => {
    expect(parseAllowedDomains(undefined)).toEqual([]);
    expect(parseAllowedDomains('')).toEqual([]);
  });

  it('trims, lowercases and dedupes a comma-separated list', () => {
    expect(
      parseAllowedDomains(' Dashverse.ai, dashtoon.com ,dashverse.ai,'),
    ).toEqual(['dashverse.ai', 'dashtoon.com']);
  });
});

describe('getEmailDomain', () => {
  it('uses the part after the last @', () => {
    expect(getEmailDomain('a@b@Dashverse.AI')).toBe('dashverse.ai');
  });

  it('returns empty for malformed input', () => {
    expect(getEmailDomain('nobody')).toBe('');
    expect(getEmailDomain('@dashverse.ai')).toBe('');
  });
});

describe('isEmailDomainAllowed', () => {
  it('allows everything when no allow-list is configured', () => {
    expect(isEmailDomainAllowed('someone@gmail.com', [])).toBe(true);
  });

  it('allows any listed domain, case-insensitively', () => {
    expect(isEmailDomainAllowed('a@DASHTOON.com', ALLOWED)).toBe(true);
    expect(isEmailDomainAllowed('a@dashverse.ai', ALLOWED)).toBe(true);
  });

  it('rejects other domains, including look-alike subdomains', () => {
    expect(isEmailDomainAllowed('a@gmail.com', ALLOWED)).toBe(false);
    expect(isEmailDomainAllowed('a@evil.dashverse.ai', ALLOWED)).toBe(false);
    expect(isEmailDomainAllowed('a@dashverse.ai.evil.com', ALLOWED)).toBe(
      false,
    );
  });
});

describe('parseGoogleIdentity', () => {
  it('accepts a verified Workspace account on an allowed domain', () => {
    expect(parseGoogleIdentity(claims(), ALLOWED)).toEqual({
      id: 'google-sub-1',
      email: 'jane@dashverse.ai',
      firstName: 'Jane',
      lastName: 'Doe',
    });
  });

  it('accepts the second allowed domain', () => {
    expect(
      parseGoogleIdentity(
        claims({ email: 'x@dashtoon.com', hd: 'dashtoon.com' }),
        ALLOWED,
      ).email,
    ).toBe('x@dashtoon.com');
  });

  it('rejects an unverified email', () => {
    expect(() =>
      parseGoogleIdentity(claims({ email_verified: false }), ALLOWED),
    ).toThrow(DomainPolicyError);
  });

  it('rejects consumer Gmail (no hd claim)', () => {
    expect(() =>
      parseGoogleIdentity(
        claims({ email: 'x@gmail.com', hd: undefined }),
        ALLOWED,
      ),
    ).toThrow(
      'Sign in with your @dashverse.ai or @dashtoon.com Google account',
    );
  });

  it('rejects a Workspace domain that is not allow-listed', () => {
    expect(() =>
      parseGoogleIdentity(
        claims({ email: 'x@pavoai.com', hd: 'pavoai.com' }),
        ALLOWED,
      ),
    ).toThrow(DomainPolicyError);
  });

  it('rejects an allowed hd vouching for an email on another domain', () => {
    expect(() =>
      parseGoogleIdentity(
        claims({ email: 'x@dashtoon.com', hd: 'dashverse.ai' }),
        ALLOWED,
      ),
    ).toThrow(DomainPolicyError);
  });

  it('rejects missing sub or email', () => {
    expect(() => parseGoogleIdentity(claims({ sub: '' }), ALLOWED)).toThrow(
      DomainPolicyError,
    );
    expect(() =>
      parseGoogleIdentity(claims({ email: undefined }), ALLOWED),
    ).toThrow(DomainPolicyError);
  });

  it('accepts any verified Google account when no allow-list is set', () => {
    expect(
      parseGoogleIdentity(claims({ email: 'x@gmail.com', hd: undefined }), [])
        .email,
    ).toBe('x@gmail.com');
  });
});

describe('isPasswordLoginEnabled', () => {
  it('is off when a Workspace allow-list is configured', () => {
    expect(
      isPasswordLoginEnabled({ GOOGLE_ALLOWED_DOMAIN: 'dashverse.ai' }),
    ).toBe(false);
  });

  it('can be switched back on as a break-glass', () => {
    expect(
      isPasswordLoginEnabled({
        GOOGLE_ALLOWED_DOMAIN: 'dashverse.ai',
        ALLOW_PASSWORD_LOGIN: 'true',
      }),
    ).toBe(true);
  });

  it('stays on without an allow-list (local dev, self-hosting)', () => {
    expect(isPasswordLoginEnabled({})).toBe(true);
  });

  it('can be switched off explicitly without an allow-list', () => {
    expect(isPasswordLoginEnabled({ ALLOW_PASSWORD_LOGIN: 'false' })).toBe(
      false,
    );
  });
});

describe('isPasswordSignUpEnabled', () => {
  it('is off with an allow-list, even with the sign-in break-glass on', () => {
    expect(
      isPasswordSignUpEnabled({
        GOOGLE_ALLOWED_DOMAIN: 'dashverse.ai',
        ALLOW_PASSWORD_LOGIN: 'true',
      }),
    ).toBe(false);
  });

  it('follows password sign-in without an allow-list', () => {
    expect(isPasswordSignUpEnabled({})).toBe(true);
    expect(isPasswordSignUpEnabled({ ALLOW_PASSWORD_LOGIN: 'false' })).toBe(
      false,
    );
  });
});

describe('isGithubLoginEnabled', () => {
  it('is off with an allow-list even when GitHub is configured', () => {
    expect(
      isGithubLoginEnabled({
        GOOGLE_ALLOWED_DOMAIN: 'dashverse.ai',
        GITHUB_CLIENT_ID: 'gh',
      }),
    ).toBe(false);
  });

  it('needs a GitHub client id without an allow-list', () => {
    expect(isGithubLoginEnabled({})).toBe(false);
    expect(isGithubLoginEnabled({ GITHUB_CLIENT_ID: 'gh' })).toBe(true);
  });
});
