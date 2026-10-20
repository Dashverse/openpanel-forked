import { DateTime } from '@openpanel/common';
import { cacheable } from '@openpanel/redis';
import sqlstring from 'sqlstring';
import { chQuery, formatClickhouseDate } from '../clickhouse/client';
import type { Invite, Prisma, ProjectAccess, User } from '../prisma-client';
import { db } from '../prisma-client';
import { createSqlBuilder } from '../sql-builder';
import { getOrganizationAccess, getProjectAccess } from './access.service';
import { type IServiceProject, getProjectById } from './project.service';
export type IServiceOrganization = Awaited<
  ReturnType<typeof db.organization.findUniqueOrThrow>
>;
export type IServiceInvite = Invite;
export type IServiceMember = Prisma.MemberGetPayload<{
  include: { user: true };
}> & { access: ProjectAccess[] };
export type IServiceProjectAccess = ProjectAccess;

export async function getOrganizations(userId: string | null) {
  if (!userId) return [];

  const organizations = await db.organization.findMany({
    where: {
      members: {
        some: {
          userId,
        },
      },
    },
    include: {
      members: {
        where: {
          userId,
        },
        select: {
          role: true,
        },
        take: 1,
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return organizations.map(({ members, ...organization }) => ({
    ...organization,
    role: members[0]?.role ?? null,
  }));
}

export function getOrganizationById(slug: string) {
  return db.organization.findUniqueOrThrow({
    where: {
      id: slug,
    },
  });
}

export async function getOrganizationByProjectId(projectId: string) {
  const project = await db.project.findUniqueOrThrow({
    where: {
      id: projectId,
    },
    include: {
      organization: true,
    },
  });

  if (!project.organization) {
    return null;
  }

  return project.organization;
}

export const getOrganizationByProjectIdCached = cacheable(
  getOrganizationByProjectId,
  60 * 5,
);

export async function getInvites(organizationId: string) {
  return db.invite.findMany({
    where: {
      organizationId,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

export async function getInviteById(inviteId: string) {
  const res = await db.invite.findUnique({
    where: {
      id: inviteId,
    },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  return {
    ...res,
    isExpired: res?.expiresAt && res.expiresAt < new Date(),
  };
}

export async function getMembers(organizationId: string) {
  const [members, access] = await Promise.all([
    db.member.findMany({
      where: {
        organizationId,
        userId: {
          not: null,
        },
      },
      include: {
        user: true,
      },
    }),
    db.projectAccess.findMany({
      where: {
        organizationId,
      },
    }),
  ]);

  return members.map((member) => ({
    ...member,
    access: access.filter((a) => a.userId === member.userId),
  }));
}

export async function getMember(organizationId: string, userId: string) {
  return db.member.findFirst({
    where: {
      organizationId,
      userId,
    },
  });
}

export async function connectUserToOrganization({
  user,
  inviteId,
}: {
  user: User;
  inviteId: string;
}) {
  // Use primary since before this we might have just created the invite
  // If we use replica it might not find the invite
  const invite = await db.$primary().invite.findUnique({
    where: {
      id: inviteId,
    },
  });

  if (!invite) {
    throw new Error('Invite not found');
  }

  if (process.env.ALLOW_INVITATION === 'false') {
    throw new Error('Invitations are not allowed');
  }

  if (invite.expiresAt < new Date()) {
    throw new Error('Invite expired');
  }

  // The invite id travels in a URL, so it is not proof of identity on its own:
  // only the person it was addressed to may redeem it.
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new Error('This invite was sent to a different email address');
  }

  const existingMember = await db.$primary().member.findUnique({
    where: {
      organizationId_userId: {
        organizationId: invite.organizationId,
        userId: user.id,
      },
    },
  });

  // Upsert against the (organizationId, userId) unique index so concurrent
  // redemption cannot create duplicate memberships. An existing membership
  // keeps its role.
  const member = await db.member.upsert({
    where: {
      organizationId_userId: {
        organizationId: invite.organizationId,
        userId: user.id,
      },
    },
    update: {},
    create: {
      organizationId: invite.organizationId,
      userId: user.id,
      role: invite.role,
      email: user.email,
      invitedById: invite.createdById,
    },
  });

  await getOrganizationAccess.clear({
    userId: user.id,
    organizationId: invite.organizationId,
  });

  if (invite.projectAccess.length > 0) {
    const currentGrants = await db.$primary().projectAccess.findMany({
      where: {
        userId: user.id,
        organizationId: invite.organizationId,
      },
    });

    // No grants on an existing member means they already see every project;
    // adding grants now would silently narrow their access.
    const alreadyUnrestricted = !!existingMember && currentGrants.length === 0;

    if (!alreadyUnrestricted) {
      const granted = new Set(currentGrants.map((grant) => grant.projectId));
      for (const projectId of invite.projectAccess) {
        await getProjectAccess.clear({ userId: user.id, projectId });
        if (granted.has(projectId)) {
          continue;
        }
        await db.projectAccess.create({
          data: {
            projectId,
            userId: user.id,
            organizationId: invite.organizationId,
            level: 'write',
          },
        });
      }
    }
  }

  await db.invite.delete({
    where: {
      id: inviteId,
    },
  });

  return member;
}

/**
 * Redeem every unexpired invite addressed to this user's email.
 *
 * Only call this for an email the identity provider has verified (Google);
 * a self-typed email/password address proves nothing about ownership.
 */
export async function claimPendingInvitesForUser(user: User) {
  const invites = await db.$primary().invite.findMany({
    where: {
      email: {
        equals: user.email,
        mode: 'insensitive',
      },
      expiresAt: {
        gt: new Date(),
      },
    },
  });

  const claimed: string[] = [];
  const failed: { inviteId: string; error: unknown }[] = [];
  for (const invite of invites) {
    try {
      await connectUserToOrganization({ user, inviteId: invite.id });
      claimed.push(invite.organizationId);
    } catch (error) {
      failed.push({ inviteId: invite.id, error });
    }
  }

  return { claimed, failed };
}

export async function hasPendingInvite(email: string) {
  const count = await db.$primary().invite.count({
    where: {
      email: {
        equals: email,
        mode: 'insensitive',
      },
      expiresAt: {
        gt: new Date(),
      },
    },
  });
  return count > 0;
}

/**
 * Get the total number of events during the
 * current subscription period for an organization
 */
export async function getOrganizationBillingEventsCount(
  organization: IServiceOrganization & { projects: IServiceProject[] },
) {
  // Dont count events if the organization has no subscription
  // Since we only use this for billing purposes
  if (
    !organization.subscriptionCurrentPeriodStart ||
    !organization.subscriptionCurrentPeriodEnd
  ) {
    return 0;
  }

  const { sb, getSql } = createSqlBuilder();

  sb.from = 'events_daily_stats';
  sb.select.count = 'countMerge(event_count) AS count';
  sb.where.projectIds = `project_id IN (${organization.projects.map((project) => sqlstring.escape(project.id)).join(',')})`;
  sb.where.createdAt = `date BETWEEN toDate(${sqlstring.escape(formatClickhouseDate(organization.subscriptionCurrentPeriodStart))}) AND toDate(${sqlstring.escape(formatClickhouseDate(organization.subscriptionCurrentPeriodEnd))})`;
  sb.where.names = `name NOT IN ('session_start', 'session_end')`;

  const res = await chQuery<{ count: number }>(getSql());
  return res[0]?.count;
}

export async function getOrganizationBillingEventsCountSerie(
  organization: IServiceOrganization & { projects: { id: string }[] },
  {
    startDate,
    endDate,
  }: {
    startDate: Date;
    endDate: Date;
  },
) {
  const interval = 'day';
  const { sb, getSql } = createSqlBuilder();

  sb.from = 'events_daily_stats';
  sb.select.count = 'countMerge(event_count) AS count';
  sb.select.day = `date AS ${interval}`;
  sb.groupBy.day = interval;
  sb.orderBy.day = `${interval} WITH FILL FROM toDate(${sqlstring.escape(formatClickhouseDate(startDate, true))}) TO toDate(${sqlstring.escape(formatClickhouseDate(endDate, true))}) STEP INTERVAL 1 ${interval.toUpperCase()}`;
  sb.where.projectIds = `project_id IN (${organization.projects.map((project) => sqlstring.escape(project.id)).join(',')})`;
  sb.where.createdAt = `${interval} BETWEEN toDate(${sqlstring.escape(formatClickhouseDate(startDate, true))}) AND toDate(${sqlstring.escape(formatClickhouseDate(endDate, true))})`;
  sb.where.names = `name NOT IN ('session_start', 'session_end')`;

  const res = await chQuery<{ count: number; day: string }>(getSql());
  return res;
}

export const getOrganizationBillingEventsCountSerieCached = cacheable(
  getOrganizationBillingEventsCountSerie,
  60 * 10,
);

export async function getOrganizationSubscriptionChartEndDate(
  projectId: string,
  endDate: string,
) {
  const organization = await getOrganizationByProjectIdCached(projectId);
  if (!organization) {
    return null;
  }
  // If the current period end date is after the subscription chart end date, we need to use the subscription chart end date
  if (
    organization.subscriptionChartEndDate &&
    new Date(endDate) > organization.subscriptionChartEndDate
  ) {
    return DateTime.fromJSDate(organization.subscriptionChartEndDate)
      .setZone(organization.timezone || DEFAULT_TIMEZONE)
      .toFormat('yyyy-MM-dd HH:mm:ss');
  }

  return endDate;
}

const DEFAULT_TIMEZONE = 'UTC';

export async function getSettingsForOrganization(organizationId: string) {
  const organization = await db.organization.findUniqueOrThrow({
    where: {
      id: organizationId,
    },
  });

  return {
    timezone: organization.timezone || DEFAULT_TIMEZONE,
  };
}

export async function getSettingsForProject(projectId: string) {
  const project = await db.project.findUniqueOrThrow({
    where: {
      id: projectId,
    },
    include: {
      organization: true,
    },
  });

  return {
    timezone: project.organization.timezone || DEFAULT_TIMEZONE,
  };
}
