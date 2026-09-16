import crypto from 'node:crypto';
import { z } from 'zod';

import type { Prisma } from '@openpanel/db';
import { db } from '@openpanel/db';

import { hashPassword } from '@openpanel/common/server';
import {
  getClientAccess,
  getOrganizationAccess,
  getProjectAccess,
} from '../access';
import { TRPCAccessError } from '../errors';
import { createTRPCRouter, protectedProcedure } from '../trpc';

export const clientRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      // Gate by project access — previously any authenticated user could list
      // any project's clients.
      const access = await getProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
      });
      if (!access) {
        throw TRPCAccessError('You do not have access to this project');
      }
      // Never return the secret column (even hashed) to the client — the
      // plaintext is shown once at creation and never again.
      return db.client.findMany({
        where: {
          projectId: input.projectId,
        },
        omit: {
          secret: true,
        },
      });
    }),
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const access = await getClientAccess({
        userId: ctx.session.userId,
        clientId: input.id,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this client');
      }

      return db.client.update({
        where: {
          id: input.id,
        },
        data: {
          name: input.name,
        },
      });
    }),
  create: protectedProcedure
    .input(
      z.object({
        name: z.string(),
        projectId: z.string(),
        organizationId: z.string(),
        type: z.enum(['read', 'write', 'root']).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Must belong to the org (previously unchecked — any authenticated user
      // could mint a client for any organizationId).
      const access = await getOrganizationAccess({
        userId: ctx.session.userId,
        organizationId: input.organizationId,
      });
      if (!access) {
        throw TRPCAccessError('You do not have access to this organization');
      }

      // Self-service tokens: any org member can mint their own `read` client
      // (scoped to a single project, read-only analytics) and `write` client
      // (ingestion). `root` clients are organization-wide (every project), so
      // those stay admin-only.
      const type = input.type ?? 'write';
      if (type === 'root' && access.role !== 'org:admin') {
        throw TRPCAccessError(
          'Only organization admins can create root (organization-wide) MCP clients',
        );
      }

      const secret = `sec_${crypto.randomBytes(10).toString('hex')}`;
      const data: Prisma.ClientCreateArgs['data'] = {
        organizationId: input.organizationId,
        projectId: input.projectId,
        name: input.name,
        type,
        secret: await hashPassword(secret),
      };

      const client = await db.client.create({ data });

      return {
        ...client,
        secret,
      };
    }),
  remove: protectedProcedure
    .input(
      z.object({
        id: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const access = await getClientAccess({
        userId: ctx.session.userId,
        clientId: input.id,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this client');
      }

      await db.client.delete({
        where: {
          id: input.id,
        },
      });
      return true;
    }),
});
