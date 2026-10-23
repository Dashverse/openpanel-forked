import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userCount: vi.fn(),
  organizationCount: vi.fn(),
  inviteFindUnique: vi.fn(),
  inviteFindFirst: vi.fn(),
}));

vi.mock('../prisma-client', () => {
  const invite = {
    findUnique: mocks.inviteFindUnique,
    findFirst: mocks.inviteFindFirst,
  };
  return {
    db: {
      user: { count: mocks.userCount },
      organization: { count: mocks.organizationCount },
      invite,
      $primary: () => ({ invite }),
    },
  };
});

import {
  getIsOrganizationCreationAllowed,
  getIsRegistrationAllowed,
} from './registration.service';

const ORIGINAL_ENV = { ...process.env };
const future = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userCount.mockResolvedValue(5);
  mocks.inviteFindUnique.mockResolvedValue(null);
  mocks.inviteFindFirst.mockResolvedValue(null);
  process.env.ALLOW_REGISTRATION = 'false';
  process.env.ALLOW_INVITATION = 'true';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('getIsRegistrationAllowed', () => {
  it('is open when ALLOW_REGISTRATION is unset', async () => {
    delete process.env.ALLOW_REGISTRATION;
    await expect(getIsRegistrationAllowed()).resolves.toBe(true);
    expect(mocks.userCount).not.toHaveBeenCalled();
  });

  it('always allows the first user of an install', async () => {
    mocks.userCount.mockResolvedValue(0);
    await expect(getIsRegistrationAllowed()).resolves.toBe(true);
  });

  it('blocks a new person without any invite', async () => {
    await expect(
      getIsRegistrationAllowed({ verifiedEmail: 'x@dashverse.ai' }),
    ).resolves.toBe(false);
  });

  it('allows a valid invite link', async () => {
    mocks.inviteFindUnique.mockResolvedValue({ id: 'i', expiresAt: future() });
    await expect(getIsRegistrationAllowed({ inviteId: 'i' })).resolves.toBe(
      true,
    );
  });

  it('rejects an invite link addressed to a different verified email', async () => {
    mocks.inviteFindUnique.mockResolvedValue({
      id: 'i',
      email: 'someone.else@dashverse.ai',
      expiresAt: future(),
    });
    await expect(
      getIsRegistrationAllowed({
        inviteId: 'i',
        verifiedEmail: 'x@dashverse.ai',
      }),
    ).resolves.toBe(false);
  });

  it('accepts an invite link addressed to the verified email, any case', async () => {
    mocks.inviteFindUnique.mockResolvedValue({
      id: 'i',
      email: 'X@Dashverse.ai',
      expiresAt: future(),
    });
    await expect(
      getIsRegistrationAllowed({
        inviteId: 'i',
        verifiedEmail: 'x@dashverse.ai',
      }),
    ).resolves.toBe(true);
  });

  it('rejects an expired invite link', async () => {
    mocks.inviteFindUnique.mockResolvedValue({ id: 'i', expiresAt: past() });
    await expect(getIsRegistrationAllowed({ inviteId: 'i' })).resolves.toBe(
      false,
    );
  });

  it('allows a verified email with a pending invite, without the link', async () => {
    mocks.inviteFindFirst.mockResolvedValue({ id: 'i' });
    await expect(
      getIsRegistrationAllowed({ verifiedEmail: 'x@dashverse.ai' }),
    ).resolves.toBe(true);
    expect(mocks.inviteFindFirst).toHaveBeenCalledWith({
      where: {
        email: { equals: 'x@dashverse.ai', mode: 'insensitive' },
        expiresAt: { gt: expect.any(Date) },
      },
    });
  });

  it('blocks everything invite-based when invitations are disabled', async () => {
    process.env.ALLOW_INVITATION = 'false';
    mocks.inviteFindUnique.mockResolvedValue({ id: 'i', expiresAt: future() });
    await expect(getIsRegistrationAllowed({ inviteId: 'i' })).resolves.toBe(
      false,
    );
  });
});

describe('getIsOrganizationCreationAllowed', () => {
  it('only allows creating the first organization', async () => {
    mocks.organizationCount.mockResolvedValue(0);
    await expect(getIsOrganizationCreationAllowed()).resolves.toBe(true);
    mocks.organizationCount.mockResolvedValue(1);
    await expect(getIsOrganizationCreationAllowed()).resolves.toBe(false);
  });
});
