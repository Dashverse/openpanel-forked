import type { GoogleIdentity } from '@openpanel/auth';

export interface GoogleAccountRepository<TUser> {
  findGoogleAccountByProviderId(
    providerId: string,
  ): Promise<{ accountId: string; user: TUser } | null>;
  findMigratableGoogleAccountByEmail(
    email: string,
  ): Promise<{ accountId: string; user: TUser } | null>;
  findUserByEmail(email: string): Promise<TUser | null>;
  updateGoogleAccount(
    accountId: string,
    identity: GoogleIdentity,
  ): Promise<void>;
  linkGoogleAccount(userId: string, identity: GoogleIdentity): Promise<void>;
  createGoogleUser(identity: GoogleIdentity): Promise<TUser>;
}

export async function resolveGoogleUser<TUser extends { id: string }>(
  identity: GoogleIdentity,
  repository: GoogleAccountRepository<TUser>,
): Promise<TUser> {
  const existingAccount =
    (await repository.findGoogleAccountByProviderId(identity.id)) ??
    (await repository.findMigratableGoogleAccountByEmail(identity.email));
  if (existingAccount) {
    await repository.updateGoogleAccount(existingAccount.accountId, identity);
    return existingAccount.user;
  }

  const existingUser = await repository.findUserByEmail(identity.email);
  if (existingUser) {
    await repository.linkGoogleAccount(existingUser.id, identity);
    return existingUser;
  }

  return repository.createGoogleUser(identity);
}

export async function resolveGoogleUserWithConflictRetry<
  TUser extends { id: string },
>(
  identity: GoogleIdentity,
  repository: GoogleAccountRepository<TUser>,
  isUniqueConflict: (error: unknown) => boolean,
): Promise<TUser> {
  try {
    return await resolveGoogleUser(identity, repository);
  } catch (error) {
    if (!isUniqueConflict(error)) {
      throw error;
    }
    return resolveGoogleUser(identity, repository);
  }
}
