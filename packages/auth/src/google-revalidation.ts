import { getGoogleAuthConfig } from './google-auth';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REQUEST_TIMEOUT_MS = 5_000;

export type RevalidationOutcome =
  | 'valid' // Google confirms the account is still active
  | 'revoked' // grant is dead: suspended, deleted, or consent withdrawn
  | 'unverifiable' // no refresh token stored, nothing to ask Google about
  | 'unavailable'; // Google could not be reached

// Google answers `invalid_grant` once a refresh token stops working, which
// covers suspended users, deleted users and revoked consent. Everything else
// (5xx, quota, a network blip) must never sign people out.
export function classifyTokenResponse(
  status: number,
  body: unknown,
): RevalidationOutcome {
  if (status >= 200 && status < 300) {
    return 'valid';
  }
  const error =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).error
      : undefined;
  return status === 400 && error === 'invalid_grant' ? 'revoked' : 'unavailable';
}

export async function revalidateGoogleGrant(
  refreshToken: string | null | undefined,
): Promise<RevalidationOutcome> {
  if (!refreshToken) {
    return 'unverifiable';
  }
  const { clientId, clientSecret } = getGoogleAuthConfig();
  try {
    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return classifyTokenResponse(response.status, await response.json().catch(() => null));
  } catch {
    return 'unavailable';
  }
}
