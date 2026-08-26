# Google-only Dashverse Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make verified `dashverse.ai` Google Workspace identities the only dashboard account login method, automatically registering or safely linking eligible users.

**Architecture:** A pure policy module in `@openpanel/auth` validates runtime configuration and Google identity claims. The API and tRPC OAuth paths consume that policy, while backend guards and UI removal close legacy provider bypasses. Session validation requires a Dashverse-domain user with a linked Google account so previously issued legacy-only sessions fail closed.

**Tech Stack:** TypeScript, Arctic OAuth, Zod, Fastify, tRPC, Prisma, TanStack Start, Vitest.

## Global Constraints

- Never commit OAuth credential values, tokens, authorization codes, or ignored `.env` content.
- `GOOGLE_ALLOWED_DOMAIN=dashverse.ai` is non-secret policy configuration.
- Both the Google `hd` claim and verified email domain must match.
- Eligible Dashverse identities auto-register regardless of `ALLOW_REGISTRATION`.
- Preserve legacy account data while disabling legacy authentication.
- Run implementation and verification under Node 22.

---

### Task 1: Google authentication policy

**Files:**
- Create: `packages/auth/src/google-auth.ts`
- Create: `packages/auth/src/google-auth.test.ts`
- Modify: `packages/auth/src/index.ts`
- Modify: `packages/auth/src/oauth.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `getGoogleAuthConfig(env?)`, `parseGoogleIdentity(claims, allowedDomain)`, `isEligibleGoogleUser(user, accounts, allowedDomain)`, and `getGoogleOAuthClient()`.

- [ ] **Step 1: Write failing policy tests**

Cover valid identity parsing, wrong/missing `hd`, unverified email, wrong and suffix-confusion email domains, case normalization, missing configuration keys, and legacy-only account eligibility.

- [ ] **Step 2: Verify the tests fail because the policy module does not exist**

Run: `pnpm vitest run packages/auth/src/google-auth.test.ts`

- [ ] **Step 3: Implement the minimal pure policy and lazy configured OAuth client**

Use an exact normalized domain comparison and exact email-domain extraction:

```ts
const emailDomain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
if (!emailVerified || hostedDomain !== allowedDomain || emailDomain !== allowedDomain) {
  throw new GoogleAuthPolicyError('Use your Dashverse Workspace account');
}
```

Configuration errors name missing keys but never include their values.

- [ ] **Step 4: Run the focused tests and package typecheck**

Run: `pnpm vitest run packages/auth/src/google-auth.test.ts`
Run: `pnpm --filter @openpanel/auth typecheck`

### Task 2: OAuth callback and legacy-user migration

**Files:**
- Modify: `apps/api/src/controllers/oauth-callback.controller.tsx`
- Create: `apps/api/src/controllers/oauth-account-linking.test.ts`

**Interfaces:**
- Consumes: Task 1 Google policy and configured OAuth client.
- Produces: callback behavior that signs in an existing Google account, creates a new eligible user, or adds a Google account to an existing same-email user.

- [ ] **Step 1: Write a failing test for same-email legacy-user linking**

The test must prove that an eligible Google identity creates an `Account` for the existing `User`, never creates a second user, and issues the session for the original user ID.

- [ ] **Step 2: Verify the regression test fails with the original-authentication error**

Run: `pnpm vitest run apps/api/src/controllers/oauth-account-linking.test.ts`

- [ ] **Step 3: Extract and implement a testable account-resolution function**

Resolve in this order: exact Google provider ID, legacy Google/email migration match, existing normalized user email, then new user. Validate identity before every database lookup or mutation.

- [ ] **Step 4: Run callback tests and API typecheck**

Run: `pnpm vitest run apps/api/src/controllers/oauth-account-linking.test.ts`
Run: `pnpm --filter @openpanel/api typecheck`

### Task 3: Close backend and session bypasses

**Files:**
- Modify: `packages/trpc/src/routers/auth.ts`
- Modify: `packages/auth/src/session.ts`
- Modify: `packages/auth/src/google-auth.test.ts`

**Interfaces:**
- Consumes: Task 1 configuration and eligibility helpers.
- Produces: Google-only OAuth start, denied email/password endpoints, and rejection of legacy-only sessions.

- [ ] **Step 1: Add failing tests for provider and session eligibility**

Assert that Google is accepted, GitHub/email are denied, eligible linked users pass, and legacy-only or wrong-domain users fail.

- [ ] **Step 2: Verify failures reflect the missing guards**

Run: `pnpm vitest run packages/auth/src/google-auth.test.ts`

- [ ] **Step 3: Implement the minimal backend guards**

Remove the pre-OAuth generic registration check, append `hd` as an account-picker hint, reject email signup/signin/reset procedures before database work, and require an eligible linked Google account during session validation.

- [ ] **Step 4: Run focused tests and package typechecks**

Run: `pnpm vitest run packages/auth/src/google-auth.test.ts`
Run: `pnpm --filter @openpanel/auth typecheck`
Run: `pnpm --filter @openpanel/trpc typecheck`

### Task 4: Google-only login UI

**Files:**
- Modify: `apps/start/src/routes/_login.login.tsx`
- Modify: `apps/start/src/routes/_public.onboarding.tsx`
- Modify: `apps/start/src/routes/_login.reset-password.tsx`
- Modify: `apps/start/src/components/auth/sign-in-google.tsx`
- Modify: `apps/start/src/modals/request-reset-password.tsx`

**Interfaces:**
- Consumes: the unchanged `auth.signInOAuth({ provider: 'google' })` client contract.
- Produces: a single Google login path with visible loading/error state.

- [ ] **Step 1: Remove GitHub and email/password controls from login and onboarding**

- [ ] **Step 2: Add mutation pending state and a visible error message to Google login**

- [ ] **Step 3: Run dashboard typecheck**

Run: `pnpm --filter start typecheck`

### Task 5: Verification and secret audit

**Files:**
- Review all changed files.

- [ ] **Step 1: Run focused tests and all affected typechecks**

Run: `pnpm vitest run packages/auth/src/google-auth.test.ts apps/api/src/controllers/oauth-account-linking.test.ts`
Run: `pnpm --filter @openpanel/auth typecheck`
Run: `pnpm --filter @openpanel/trpc typecheck`
Run: `pnpm --filter @openpanel/api typecheck`
Run: `pnpm --filter start typecheck`

- [ ] **Step 2: Run integrity and secret checks**

Run: `git diff --check`
Run: `git status --short`
Inspect `git diff --cached` and `git diff` for credential-shaped values and confirm `.env` is absent.

- [ ] **Step 3: Commit implementation without attribution trailers**

```bash
git commit -m "feat(auth): restrict access to Dashverse Google accounts"
```
