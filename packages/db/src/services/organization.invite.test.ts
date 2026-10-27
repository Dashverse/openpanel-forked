import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  inviteFindUnique: vi.fn(),
  inviteFindMany: vi.fn(),
  inviteDeleteMany: vi.fn(),
  memberFindUnique: vi.fn(),
  memberUpsert: vi.fn(),
  projectAccessFindMany: vi.fn(),
  projectAccessCreateMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../prisma-client', () => {
  const client = {
    invite: {
      findUnique: mocks.inviteFindUnique,
      findMany: mocks.inviteFindMany,
      deleteMany: mocks.inviteDeleteMany,
    },
    member: { findUnique: mocks.memberFindUnique, upsert: mocks.memberUpsert },
    projectAccess: {
      findMany: mocks.projectAccessFindMany,
      createMany: mocks.projectAccessCreateMany,
    },
  };
  // Interactive transaction: run the callback against the same client
  mocks.transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(client),
  );
  return {
    db: { ...client, $primary: () => client, $transaction: mocks.transaction },
  };
});

vi.mock('./access.service', () => ({
  getOrganizationAccess: { clear: vi.fn() },
  getProjectAccess: { clear: vi.fn() },
}));

import {
  claimPendingInvitesForUser,
  connectUserToOrganization,
} from './organization.service';

const user = { id: 'u1', email: 'Jane@Dashverse.ai' } as any;
const invite = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv1',
  email: 'jane@dashverse.ai',
  organizationId: 'dashverse',
  role: 'org:member',
  createdById: 'admin',
  projectAccess: [] as string[],
  expiresAt: new Date(Date.now() + 60_000),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ALLOW_INVITATION;
  mocks.memberFindUnique.mockResolvedValue(null);
  mocks.memberUpsert.mockResolvedValue({ id: 'm1' });
  mocks.projectAccessFindMany.mockResolvedValue([]);
  mocks.inviteDeleteMany.mockResolvedValue({ count: 1 });
  mocks.projectAccessCreateMany.mockResolvedValue({ count: 0 });
});

describe('connectUserToOrganization', () => {
  it('joins the org with the invited role and consumes the invite', async () => {
    mocks.inviteFindUnique.mockResolvedValue(invite());
    await connectUserToOrganization({ user, inviteId: 'inv1' });
    expect(mocks.memberUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {},
        create: expect.objectContaining({
          organizationId: 'dashverse',
          userId: 'u1',
          role: 'org:member',
        }),
      }),
    );
    expect(mocks.inviteDeleteMany).toHaveBeenCalledWith({
      where: { id: 'inv1' },
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('refuses an invite addressed to someone else', async () => {
    mocks.inviteFindUnique.mockResolvedValue(
      invite({ email: 'other@dashverse.ai' }),
    );
    await expect(
      connectUserToOrganization({ user, inviteId: 'inv1' }),
    ).rejects.toThrow('different email address');
    expect(mocks.memberUpsert).not.toHaveBeenCalled();
    expect(mocks.inviteDeleteMany).not.toHaveBeenCalled();
  });

  it('refuses an expired invite', async () => {
    mocks.inviteFindUnique.mockResolvedValue(
      invite({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(
      connectUserToOrganization({ user, inviteId: 'inv1' }),
    ).rejects.toThrow('Invite expired');
  });

  it('grants only the invited projects to a new member', async () => {
    mocks.inviteFindUnique.mockResolvedValue(
      invite({ projectAccess: ['frameo', 'studio'] }),
    );
    await connectUserToOrganization({ user, inviteId: 'inv1' });
    expect(mocks.projectAccessCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ projectId: 'frameo', level: 'write' }),
        expect.objectContaining({ projectId: 'studio', level: 'write' }),
      ],
    });
  });

  it('fails as a whole (inside the transaction) if a grant insert fails', async () => {
    mocks.inviteFindUnique.mockResolvedValue(
      invite({ projectAccess: ['frameo'] }),
    );
    mocks.projectAccessCreateMany.mockRejectedValue(new Error('db down'));
    await expect(
      connectUserToOrganization({ user, inviteId: 'inv1' }),
    ).rejects.toThrow('db down');
    // Membership, invite claim and grants all ran in the one transaction, so
    // Postgres rolls back all of them and the invite can be redeemed again.
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.memberUpsert).toHaveBeenCalledTimes(1);
  });

  it('refuses an invite that was already used concurrently', async () => {
    mocks.inviteFindUnique.mockResolvedValue(invite());
    mocks.inviteDeleteMany.mockResolvedValue({ count: 0 });
    await expect(
      connectUserToOrganization({ user, inviteId: 'inv1' }),
    ).rejects.toThrow('Invite already used');
    expect(mocks.memberUpsert).not.toHaveBeenCalled();
  });

  it('never narrows an existing member who already sees every project', async () => {
    mocks.memberFindUnique.mockResolvedValue({ id: 'm1' });
    mocks.projectAccessFindMany.mockResolvedValue([]);
    mocks.inviteFindUnique.mockResolvedValue(
      invite({ projectAccess: ['frameo'] }),
    );
    await connectUserToOrganization({ user, inviteId: 'inv1' });
    expect(mocks.projectAccessCreateMany).not.toHaveBeenCalled();
    expect(mocks.inviteDeleteMany).toHaveBeenCalled();
  });

  it('adds only missing grants to an existing restricted member', async () => {
    mocks.memberFindUnique.mockResolvedValue({ id: 'm1' });
    mocks.projectAccessFindMany.mockResolvedValue([{ projectId: 'frameo' }]);
    mocks.inviteFindUnique.mockResolvedValue(
      invite({ projectAccess: ['frameo', 'studio'] }),
    );
    await connectUserToOrganization({ user, inviteId: 'inv1' });
    expect(mocks.projectAccessCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ projectId: 'studio' })],
    });
  });
});

describe('claimPendingInvitesForUser', () => {
  it('redeems every pending invite for the email and reports failures', async () => {
    mocks.inviteFindMany.mockResolvedValue([
      invite({ id: 'a', organizationId: 'dashverse' }),
      invite({ id: 'b', organizationId: 'other' }),
    ]);
    mocks.inviteFindUnique.mockImplementation(({ where }) =>
      where.id === 'a'
        ? invite({ id: 'a' })
        : invite({ id: 'b', expiresAt: new Date(Date.now() - 1000) }),
    );

    const result = await claimPendingInvitesForUser(user);

    expect(result.claimed).toEqual(['dashverse']);
    expect(result.failed.map((f) => f.inviteId)).toEqual(['b']);
    expect(mocks.inviteFindMany).toHaveBeenCalledWith({
      where: {
        email: { equals: 'Jane@Dashverse.ai', mode: 'insensitive' },
        expiresAt: { gt: expect.any(Date) },
      },
    });
  });
});
