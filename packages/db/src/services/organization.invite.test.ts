import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  inviteFindUnique: vi.fn(),
  inviteFindMany: vi.fn(),
  inviteDelete: vi.fn(),
  memberFindUnique: vi.fn(),
  memberUpsert: vi.fn(),
  projectAccessFindMany: vi.fn(),
  projectAccessCreate: vi.fn(),
}));

vi.mock('../prisma-client', () => {
  const client = {
    invite: {
      findUnique: mocks.inviteFindUnique,
      findMany: mocks.inviteFindMany,
      delete: mocks.inviteDelete,
    },
    member: { findUnique: mocks.memberFindUnique, upsert: mocks.memberUpsert },
    projectAccess: {
      findMany: mocks.projectAccessFindMany,
      create: mocks.projectAccessCreate,
    },
  };
  return { db: { ...client, $primary: () => client } };
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
    expect(mocks.inviteDelete).toHaveBeenCalledWith({ where: { id: 'inv1' } });
  });

  it('refuses an invite addressed to someone else', async () => {
    mocks.inviteFindUnique.mockResolvedValue(
      invite({ email: 'other@dashverse.ai' }),
    );
    await expect(
      connectUserToOrganization({ user, inviteId: 'inv1' }),
    ).rejects.toThrow('different email address');
    expect(mocks.memberUpsert).not.toHaveBeenCalled();
    expect(mocks.inviteDelete).not.toHaveBeenCalled();
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
    expect(mocks.projectAccessCreate).toHaveBeenCalledTimes(2);
    expect(mocks.projectAccessCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ projectId: 'frameo', level: 'write' }),
    });
  });

  it('never narrows an existing member who already sees every project', async () => {
    mocks.memberFindUnique.mockResolvedValue({ id: 'm1' });
    mocks.projectAccessFindMany.mockResolvedValue([]);
    mocks.inviteFindUnique.mockResolvedValue(
      invite({ projectAccess: ['frameo'] }),
    );
    await connectUserToOrganization({ user, inviteId: 'inv1' });
    expect(mocks.projectAccessCreate).not.toHaveBeenCalled();
    expect(mocks.inviteDelete).toHaveBeenCalled();
  });

  it('adds only missing grants to an existing restricted member', async () => {
    mocks.memberFindUnique.mockResolvedValue({ id: 'm1' });
    mocks.projectAccessFindMany.mockResolvedValue([{ projectId: 'frameo' }]);
    mocks.inviteFindUnique.mockResolvedValue(
      invite({ projectAccess: ['frameo', 'studio'] }),
    );
    await connectUserToOrganization({ user, inviteId: 'inv1' });
    expect(mocks.projectAccessCreate).toHaveBeenCalledTimes(1);
    expect(mocks.projectAccessCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ projectId: 'studio' }),
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
