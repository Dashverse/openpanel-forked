export type { OAuth2Tokens } from 'arctic';
import * as Arctic from 'arctic';
import { getGoogleAuthConfig } from './google-auth';

export { Arctic };

export function getGoogleOAuthClient() {
  const config = getGoogleAuthConfig();
  return new Arctic.Google(
    config.clientId,
    config.clientSecret,
    config.redirectUri,
  );
}
