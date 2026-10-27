import { z } from 'zod';

import {
  connectUserToOrganization,
  db,
  getInviteById,
  getInvites,
  getMembers,
  getOrganizationById,
  getOrganizations,
} from '@openpanel/db';
import { zEditOrganization, zInviteUser } from '@openpanel/validation';

import { describeAllowedDomains, isEmailDomainAllowed } from '@openpanel/auth';
import { generateSecureId } from '@openpanel/common/server';
import { sendEmail } from '@openpanel/email';
import { addDays } from 'date-fns';
import { getOrganizationAccess } from '../access';
import { TRPCAccessError, TRPCBadRequestError } from '../errors';
import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
  rateLimitMiddleware,
} from '../trpc';

const INVITE_TTL_DAYS = 14;

function getInviteUrl(inviteId: string) {
  return `${process.env.DASHBOARD_URL || process.env.NEXT_PUBLIC_DASHBOARD_URL}/onboarding?inviteId=${inviteId}`;
}

async function assertMember(userId: string, organizationId: string) {
  const access = await getOrganizationAccess({ userId, organizationId });
  if (!access) {
    throw TRPCAccessError('You do not have access to this organization');
  }
  return access;
}

async function assertAdmin(userId: string, organizationId: string) {
  const access = await getOrganizationAccess({ userId, organizationId });
  if (access?.role !== 'org:admin') {
    throw TRPCAccessError('Only organization admins can do this');
  }
  return access;
}

export const organizationRouter = createTRPCRouter({
  get: protectedProcedure
    .input(z.object({ organizationId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertMember(ctx.session.userId, input.organizationId);
      return getOrganizationById(input.organizationId);
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    return getOrganizations(ctx.session.userId);
  }),

  update: protectedProcedure
    .input(zEditOrganization)
    .mutation(async ({ input, ctx }) => {
      const access = await getOrganizationAccess({
        userId: ctx.session.userId,
        organizationId: input.id,
      });

      if (access?.role !== 'org:admin') {
        throw TRPCAccessError('You do not have access to this project');
      }

      return db.organization.update({
        where: {
          id: input.id,
        },
        data: {
          name: input.name,
          timezone: input.timezone,
        },
      });
    }),

  inviteUser: protectedProcedure
    .input(zInviteUser)
    .mutation(async ({ input, ctx }) => {
      const access = await getOrganizationAccess({
        userId: ctx.session.userId,
        organizationId: input.organizationId,
      });

      if (access?.role !== 'org:admin') {
        throw TRPCAccessError('You do not have access to this project');
      }

      const email = input.email.trim().toLowerCase();
      if (!isEmailDomainAllowed(email)) {
        throw TRPCBadRequestError(
          `Only ${describeAllowedDomains()} email addresses can be invited`,
        );
      }

      const userExists = await db.user.findFirst({
        where: {
          email: {
            equals: email,
            mode: 'insensitive',
          },
        },
      });

      const alreadyMember = await db.member.findFirst({
        where: {
          userId: userExists?.id,
          organizationId: input.organizationId,
        },
      });

      if (alreadyMember && userExists) {
        throw TRPCBadRequestError(
          'User is already a member of the organization',
        );
      }

      const alreadyInvited = await db.invite.findFirst({
        where: {
          email,
          organizationId: input.organizationId,
        },
      });

      if (alreadyInvited) {
        throw TRPCBadRequestError(
          'User is already invited to the organization',
        );
      }

      const invite = await db.invite.create({
        data: {
          id: generateSecureId('invite'),
          email,
          organizationId: input.organizationId,
          role: input.role,
          createdById: ctx.session.userId,
          projectAccess: input.access || [],
          expiresAt: addDays(new Date(), INVITE_TTL_DAYS),
        },
        include: {
          organization: {
            select: {
              name: true,
            },
          },
        },
      });

      if (userExists) {
        const member = await connectUserToOrganization({
          user: userExists,
          inviteId: invite.id,
        });

        return {
          type: 'is_member',
          member,
        };
      }

      await sendEmail('invite', {
        to: email,
        data: {
          url: getInviteUrl(invite.id),
          organizationName: invite.organization.name,
        },
      });

      return {
        type: 'is_invited',
        invite,
      };
    }),
  resendInvite: protectedProcedure
    .input(z.object({ inviteId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const invite = await db.invite.findUniqueOrThrow({
        where: { id: input.inviteId },
        include: { organization: { select: { name: true } } },
      });

      await assertAdmin(ctx.session.userId, invite.organizationId);

      // Resending also revives an expired invite, so admins never have to
      // revoke and re-create one.
      const updated = await db.invite.update({
        where: { id: invite.id },
        data: { expiresAt: addDays(new Date(), INVITE_TTL_DAYS) },
      });

      await sendEmail('invite', {
        to: invite.email,
        data: {
          url: getInviteUrl(invite.id),
          organizationName: invite.organization.name,
        },
      });

      return updated;
    }),

  revokeInvite: protectedProcedure
    .input(
      z.object({
        inviteId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const invite = await db.invite.findUniqueOrThrow({
        where: {
          id: input.inviteId,
        },
      });

      const access = await getOrganizationAccess({
        userId: ctx.session.userId,
        organizationId: invite.organizationId,
      });

      if (access?.role !== 'org:admin') {
        throw TRPCAccessError('You do not have access to this project');
      }

      return db.invite.delete({
        where: {
          id: input.inviteId,
        },
      });
    }),

  removeMember: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        userId: z.string(),
        id: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const exists = await db.member.count({
        where: {
          userId: input.userId,
          organizationId: input.organizationId,
        },
      });

      if (ctx.session.userId === input.userId && exists === 1) {
        throw new Error('You cannot remove yourself from the organization');
      }

      const access = await getOrganizationAccess({
        userId: ctx.session.userId,
        organizationId: input.organizationId,
      });

      if (access?.role !== 'org:admin') {
        throw TRPCAccessError('You do not have access to this project');
      }

      await db.$transaction([
        db.member.delete({
          where: {
            id: input.id,
            userId: input.userId,
            organizationId: input.organizationId,
          },
        }),
        db.projectAccess.deleteMany({
          where: {
            userId: input.userId,
            organizationId: input.organizationId,
          },
        }),
      ]);
    }),

  updateMemberAccess: protectedProcedure
    .input(
      z.object({
        userId: z.string(),
        organizationId: z.string(),
        access: z.array(z.string()),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.userId === ctx.session.userId) {
        throw TRPCAccessError('You cannot update your own access');
      }

      const access = await getOrganizationAccess({
        userId: ctx.session.userId,
        organizationId: input.organizationId,
      });

      if (access?.role !== 'org:admin') {
        throw TRPCAccessError('You do not have access to this project');
      }

      return db.$transaction([
        db.projectAccess.deleteMany({
          where: {
            userId: input.userId,
            organizationId: input.organizationId,
          },
        }),
        db.projectAccess.createMany({
          data: input.access.map((projectId) => ({
            userId: input.userId,
            organizationId: input.organizationId,
            projectId: projectId,
            level: 'read',
          })),
        }),
      ]);
    }),

  members: protectedProcedure
    .input(z.object({ organizationId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertMember(ctx.session.userId, input.organizationId);
      return getMembers(input.organizationId);
    }),

  // Invite ids are the redeemable token in the invite link, so only admins
  // may list them.
  invitations: protectedProcedure
    .input(z.object({ organizationId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertAdmin(ctx.session.userId, input.organizationId);
      return getInvites(input.organizationId);
    }),

  getInvite: publicProcedure
    .use(
      rateLimitMiddleware({
        max: 5,
        windowMs: 30_000,
      }),
    )
    .input(z.object({ inviteId: z.string().optional() }))
    .query(async ({ input }) => {
      if (!input.inviteId) {
        throw TRPCBadRequestError('Invite ID is required');
      }
      return getInviteById(input.inviteId);
    }),
});
