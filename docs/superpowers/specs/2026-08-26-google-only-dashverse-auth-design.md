# Google-only Dashverse authentication

## Goal

Restrict dashboard account access to verified Google Workspace identities whose
hosted domain and email domain are both `dashverse.ai`. Valid identities are
automatically registered on first login. GitHub and password authentication
must not provide alternate access paths.

## Authentication policy

- Google OAuth is the only account authentication method exposed by the UI or
  accepted by the account-authentication API.
- The Google ID token must contain `email_verified: true`,
  `hd: "dashverse.ai"`, and an email ending exactly in `@dashverse.ai` after
  lowercase normalization.
- The authorization request may include `hd=dashverse.ai` to guide account
  selection, but the callback claim checks are authoritative.
- A valid Dashverse identity may create an account even when
  `ALLOW_REGISTRATION=false`. Google Workspace membership is the registration
  allowlist for this deployment.
- If a user with the same normalized email already exists under a legacy
  provider, the verified Google account is linked to that user. A second user
  is never created. Linking occurs only after all Google domain and verification
  checks pass.
- Provider identities are database-unique. If concurrent callbacks race, the
  losing request re-resolves the account created by the winner from the primary
  database. The migration safely collapses same-user duplicates and stops for
  manual review if one provider identity is attached to different users.
- Existing sessions are accepted only for users with a matching Dashverse email
  and a Google account marked as Workspace-verified by the hardened callback.
  Historical and legacy-only sessions are invalidated without deleting user
  data. Demo-user session fabrication is disabled, and a stale `DEMO_USER_ID`
  configuration prevents API startup.
- Share-password authentication is not an account login and remains unchanged.

## Configuration and secret handling

The API consumes these runtime variables:

- `GOOGLE_CLIENT_ID`: non-secret, environment-specific identifier.
- `GOOGLE_CLIENT_SECRET`: secret; never committed.
- `GOOGLE_REDIRECT_URI`: non-secret exact public callback URL.
- `GOOGLE_ALLOWED_DOMAIN`: non-secret policy value, set to `dashverse.ai`.

`.env.example` documents names and safe placeholders only. The ignored local
`.env` may contain developer credentials. Production injects client credentials
at container runtime from the deployment secret store; they must not be Docker
build arguments, image layers, workflow output, or committed manifests.

The API validates authentication configuration at startup and fails closed with
a clear server-side error when any required Google variable is missing. Logs
must report missing variable names without reporting values, tokens,
authorization codes, or identity claims.

## Components

1. A small shared Google-auth policy module owns configuration validation,
   identity-claim parsing, domain normalization, and eligibility checks.
2. The tRPC OAuth-start procedure accepts only Google, adds the non-authoritative
   hosted-domain hint, and no longer applies the generic registration gate.
3. The API callback validates identity before any account lookup or mutation,
   links an existing same-email user when necessary, creates new eligible users,
   and issues a session.
4. Session validation rejects sessions whose user lacks an eligible Google
   account.
5. Login and onboarding UI expose only Google authentication. Direct email,
   password-reset, and GitHub account-authentication procedures and callbacks
   are removed, so they cannot perform work or log submitted credentials.

## Error behavior

- Wrong or missing hosted domain: return to login with a generic instruction to
  use a Dashverse Workspace account.
- Unverified or wrong-domain email: reject before querying or mutating users.
- Missing server configuration: log only the missing key and return a generic
  login error with the request correlation ID.
- Same eligible email under a legacy provider: link Google and continue instead
  of returning "original authentication method".

## Verification

Focused tests cover an eligible identity, wrong `hd`, missing `hd`, wrong email
domain, suffix-confusion addresses, unverified email, case normalization,
missing configuration, legacy-user linking, provider rejection, and legacy-only
session rejection. Targeted package typechecks and tests run under Node 22.

Before handoff, inspect the complete diff, run `git diff --check`, and scan
tracked changes for OAuth secrets, tokens, authorization codes, and private
`.env` content.

## Out of scope

- Changing Google Cloud project-wide Audience settings.
- Deleting legacy accounts or their data.
- The unrelated TanStack Start `flatRoutes` local runtime failure, which is
  diagnosed and fixed separately from the authentication policy.
