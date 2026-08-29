import { describe, expect, it } from 'vitest';
import { classifyTokenResponse } from './google-revalidation';

describe('classifyTokenResponse', () => {
  it('treats a 200 as still active', () => {
    expect(classifyTokenResponse(200, { access_token: 'x' })).toBe('valid');
  });

  it('treats invalid_grant as revoked — suspended, deleted or consent withdrawn', () => {
    expect(classifyTokenResponse(400, { error: 'invalid_grant' })).toBe(
      'revoked',
    );
  });

  it('does not sign people out on a server error', () => {
    expect(classifyTokenResponse(500, null)).toBe('unavailable');
    expect(classifyTokenResponse(503, { error: 'backendError' })).toBe(
      'unavailable',
    );
  });

  it('does not sign people out on rate limiting', () => {
    expect(classifyTokenResponse(429, { error: 'rateLimitExceeded' })).toBe(
      'unavailable',
    );
  });

  it('does not sign people out on an unparseable body', () => {
    expect(classifyTokenResponse(400, null)).toBe('unavailable');
    expect(classifyTokenResponse(400, 'not json')).toBe('unavailable');
  });

  it('does not treat other 400s as revocation', () => {
    // A misconfigured client must surface as an outage, not a mass logout.
    expect(classifyTokenResponse(400, { error: 'invalid_client' })).toBe(
      'unavailable',
    );
  });

  it('returns unverifiable when there is no refresh token to check', async () => {
    const { revalidateGoogleGrant } = await import('./google-revalidation');
    expect(await revalidateGoogleGrant(null)).toBe('unverifiable');
    expect(await revalidateGoogleGrant(undefined)).toBe('unverifiable');
    expect(await revalidateGoogleGrant('')).toBe('unverifiable');
  });
});
