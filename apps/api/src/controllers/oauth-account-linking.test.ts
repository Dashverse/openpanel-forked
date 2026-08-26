import type { GoogleIdentity } from '@openpanel/auth';
import { describe, expect, it } from 'vitest';
import {
  type GoogleAccountRepository,
  resolveGoogleUser,
  resolveGoogleUserWithConflictRetry,
} from './oauth-account-linking';

interface TestUser {
  id: string;
  email: string;
}

interface TestAccount {
  id: string;
  userId: string;
  provider: string;
  providerId: string | null;
  email: string | null;
}

function createRepository({
  users,
  accounts,
}: {
  users: TestUser[];
  accounts: TestAccount[];
}): GoogleAccountRepository<TestUser> {
  const toResult = (account: TestAccount | undefined) => {
    if (!account) return null;
    return {
      accountId: account.id,
      user: users.find((user) => user.id === account.userId)!,
    };
  };

  return {
    async findGoogleAccountByProviderId(providerId) {
      return toResult(
        accounts.find(
          (candidate) =>
            candidate.provider === 'google' &&
            candidate.providerId === providerId,
        ),
      );
    },
    async findMigratableGoogleAccountByEmail(email) {
      return toResult(
        accounts.find(
          (candidate) =>
            (candidate.provider === 'google' &&
              candidate.providerId === null &&
              candidate.email?.toLowerCase() === email.toLowerCase()) ||
            (candidate.provider === 'oauth' &&
              users
                .find((user) => user.id === candidate.userId)
                ?.email.toLowerCase() === email.toLowerCase()),
        ),
      );
    },
    async findUserByEmail(email) {
      return (
        users.find(
          (user) => user.email.toLowerCase() === email.toLowerCase(),
        ) ?? null
      );
    },
    async updateGoogleAccount(accountId, identity) {
      const account = accounts.find((candidate) => candidate.id === accountId)!;
      account.provider = 'google';
      account.providerId = identity.id;
      account.email = identity.email;
    },
    async linkGoogleAccount(userId, identity) {
      accounts.push({
        id: `account-${accounts.length + 1}`,
        userId,
        provider: 'google',
        providerId: identity.id,
        email: identity.email,
      });
    },
    async createGoogleUser(identity) {
      const user = { id: `user-${users.length + 1}`, email: identity.email };
      users.push(user);
      accounts.push({
        id: `account-${accounts.length + 1}`,
        userId: user.id,
        provider: 'google',
        providerId: identity.id,
        email: identity.email,
      });
      return user;
    },
  };
}

const identity: GoogleIdentity = {
  id: 'google-123',
  email: 'person@dashverse.ai',
  hostedDomain: 'dashverse.ai',
  firstName: 'Dash',
  lastName: 'User',
};

describe('resolveGoogleUser', () => {
  it('links a verified Google identity to an existing same-email user', async () => {
    const users = [{ id: 'legacy-user', email: 'Person@Dashverse.AI' }];
    const accounts: TestAccount[] = [
      {
        id: 'email-account',
        userId: 'legacy-user',
        provider: 'email',
        providerId: null,
        email: 'Person@Dashverse.AI',
      },
    ];

    const user = await resolveGoogleUser(
      identity,
      createRepository({ users, accounts }),
    );

    expect(user).toEqual({ id: 'legacy-user', email: 'Person@Dashverse.AI' });
    expect(users).toHaveLength(1);
    expect(accounts).toContainEqual({
      id: 'account-2',
      userId: 'legacy-user',
      provider: 'google',
      providerId: 'google-123',
      email: 'person@dashverse.ai',
    });
  });

  it('updates and returns an existing Google account owner', async () => {
    const users = [{ id: 'google-user', email: 'person@dashverse.ai' }];
    const accounts: TestAccount[] = [
      {
        id: 'google-account',
        userId: 'google-user',
        provider: 'google',
        providerId: 'google-123',
        email: 'old@dashverse.ai',
      },
    ];

    const user = await resolveGoogleUser(
      identity,
      createRepository({ users, accounts }),
    );

    expect(user.id).toBe('google-user');
    expect(accounts[0]?.email).toBe('person@dashverse.ai');
  });

  it('prefers an exact Google provider ID over an email migration match', async () => {
    const users = [
      { id: 'migration-user', email: 'person@dashverse.ai' },
      { id: 'google-user', email: 'old@dashverse.ai' },
    ];
    const accounts: TestAccount[] = [
      {
        id: 'migration-account',
        userId: 'migration-user',
        provider: 'oauth',
        providerId: null,
        email: null,
      },
      {
        id: 'google-account',
        userId: 'google-user',
        provider: 'google',
        providerId: 'google-123',
        email: 'old@dashverse.ai',
      },
    ];

    const user = await resolveGoogleUser(
      identity,
      createRepository({ users, accounts }),
    );

    expect(user.id).toBe('google-user');
    expect(accounts[0]?.provider).toBe('oauth');
    expect(accounts[1]?.email).toBe('person@dashverse.ai');
  });

  it('creates a user when no matching account or email exists', async () => {
    const users: TestUser[] = [];
    const accounts: TestAccount[] = [];

    const user = await resolveGoogleUser(
      identity,
      createRepository({ users, accounts }),
    );

    expect(user).toEqual({ id: 'user-1', email: 'person@dashverse.ai' });
    expect(accounts[0]?.provider).toBe('google');
  });

  it('re-resolves the winning account after a concurrent unique conflict', async () => {
    const users = [{ id: 'legacy-user', email: 'person@dashverse.ai' }];
    const accounts: TestAccount[] = [];
    const repository = createRepository({ users, accounts });
    const linkGoogleAccount = repository.linkGoogleAccount;
    const uniqueConflict = new Error('unique conflict');
    let firstAttempt = true;
    repository.linkGoogleAccount = async (userId, googleIdentity) => {
      await linkGoogleAccount(userId, googleIdentity);
      if (firstAttempt) {
        firstAttempt = false;
        throw uniqueConflict;
      }
    };

    const user = await resolveGoogleUserWithConflictRetry(
      identity,
      repository,
      (error) => error === uniqueConflict,
    );

    expect(user.id).toBe('legacy-user');
    expect(accounts).toHaveLength(1);
  });
});
