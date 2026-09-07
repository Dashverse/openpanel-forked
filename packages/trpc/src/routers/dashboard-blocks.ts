import { toFineReportLayout, toLegacyReportLayout } from '@openpanel/common';
import { db } from '@openpanel/db';
import {
  dashboardBlockKindSchema,
  dashboardBlockSchema,
  getDashboardBlockDefinition,
  parseDashboardBlock,
} from '@openpanel/validation';
import { z } from 'zod';
import { getProjectAccess } from '../access';
import {
  TRPCAccessError,
  TRPCBadRequestError,
  TRPCNotFoundError,
} from '../errors';
import { protectedProcedure } from '../trpc';

const dashboardInput = z.object({ dashboardId: z.string() });
const blockInput = z.object({ id: z.string().uuid() });
const gridItem = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['report', 'block']),
    x: z.number().int().min(0).max(11),
    y: z.number().int().min(0).max(1000000),
    w: z.number().int().min(1).max(12),
    h: z.number().int().min(1).max(100000),
    minW: z.number().int().min(1).max(12).optional(),
    minH: z.number().int().min(1).max(100000).optional(),
    maxW: z.number().int().min(1).max(12).optional(),
    maxH: z.number().int().min(1).max(100000).optional(),
  })
  .refine((item) => item.x + item.w <= 12, 'Item extends beyond the dashboard');

async function authorizeDashboard(dashboardId: string, userId: string) {
  const dashboard = await db.dashboard.findUnique({
    where: { id: dashboardId },
  });
  if (!dashboard) throw TRPCNotFoundError('Dashboard not found');
  if (!(await getProjectAccess({ projectId: dashboard.projectId, userId }))) {
    throw TRPCAccessError('You do not have access to this dashboard');
  }
  return dashboard;
}

async function authorizeBlock(id: string, userId: string) {
  const block = await db.dashboardBlock.findUnique({ where: { id } });
  if (!block) throw TRPCNotFoundError('Block not found');
  await authorizeDashboard(block.dashboardId, userId);
  return block;
}

async function getGrid(
  tx: Pick<typeof db, 'report' | 'dashboardBlock'>,
  dashboardId: string,
) {
  const [reports, blocks] = await Promise.all([
    tx.report.findMany({
      where: { dashboardId },
      include: { layout: true },
    }),
    tx.dashboardBlock.findMany({
      where: { dashboardId },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return [
    ...reports.map((report, index) =>
      toFineReportLayout(report.id, report.layout, index),
    ),
    ...blocks.map(({ id, x, y, w, h, minW, minH }) => ({
      id,
      kind: 'block' as const,
      x,
      y,
      w,
      h,
      minW,
      minH,
    })),
  ];
}

export const dashboardBlockProcedures = {
  listBlocks: protectedProcedure
    .input(dashboardInput)
    .query(async ({ input, ctx }) => {
      await authorizeDashboard(input.dashboardId, ctx.session.userId);
      const blocks = await db.dashboardBlock.findMany({
        where: { dashboardId: input.dashboardId },
        orderBy: { createdAt: 'asc' },
      });
      return blocks.map((block) => ({
        ...block,
        ...parseDashboardBlock(block),
      }));
    }),
  getLayout: protectedProcedure
    .input(dashboardInput)
    .query(async ({ input, ctx }) => {
      await authorizeDashboard(input.dashboardId, ctx.session.userId);
      return getGrid(db, input.dashboardId);
    }),
  createBlock: protectedProcedure
    .input(dashboardInput.extend({ kind: dashboardBlockKindSchema }))
    .mutation(async ({ input, ctx }) => {
      await authorizeDashboard(input.dashboardId, ctx.session.userId);
      return db.$transaction(async (tx) => {
        const layout = await getGrid(tx, input.dashboardId);
        const definition = getDashboardBlockDefinition(input.kind);
        return tx.dashboardBlock.create({
          data: {
            dashboardId: input.dashboardId,
            kind: input.kind,
            config: definition.defaultConfig,
            ...definition.defaultLayout,
            y: Math.max(0, ...layout.map((item) => item.y + item.h)),
          },
        });
      });
    }),
  updateBlock: protectedProcedure
    .input(blockInput.and(dashboardBlockSchema))
    .mutation(async ({ input, ctx }) => {
      const block = await authorizeBlock(input.id, ctx.session.userId);
      if (block.kind !== input.kind)
        throw TRPCBadRequestError('Block kind cannot be changed');
      return db.dashboardBlock.update({
        where: { id: input.id },
        data: { config: input.config },
      });
    }),
  duplicateBlock: protectedProcedure
    .input(blockInput)
    .mutation(async ({ input, ctx }) => {
      const block = await authorizeBlock(input.id, ctx.session.userId);
      return db.$transaction(async (tx) => {
        const layout = await getGrid(tx, block.dashboardId);
        const { id, createdAt, updatedAt, ...data } = block;
        return tx.dashboardBlock.create({
          data: {
            ...data,
            config: parseDashboardBlock(block).config,
            y: Math.max(0, ...layout.map((item) => item.y + item.h)),
          },
        });
      });
    }),
  deleteBlock: protectedProcedure
    .input(blockInput)
    .mutation(async ({ input, ctx }) => {
      await authorizeBlock(input.id, ctx.session.userId);
      return db.dashboardBlock.delete({ where: { id: input.id } });
    }),
  saveLayout: protectedProcedure
    .input(dashboardInput.extend({ items: z.array(gridItem).max(1000) }))
    .mutation(async ({ input, ctx }) => {
      await authorizeDashboard(input.dashboardId, ctx.session.userId);
      if (
        new Set(input.items.map((item) => item.id)).size !== input.items.length
      )
        throw TRPCBadRequestError('Duplicate layout items');
      const [reports, blocks] = await Promise.all([
        db.report.findMany({
          where: {
            dashboardId: input.dashboardId,
            id: {
              in: input.items
                .filter((item) => item.kind === 'report')
                .map((item) => item.id),
            },
          },
          select: { id: true },
        }),
        db.dashboardBlock.findMany({
          where: {
            dashboardId: input.dashboardId,
            id: {
              in: input.items
                .filter((item) => item.kind === 'block')
                .map((item) => item.id),
            },
          },
          select: { id: true, kind: true },
        }),
      ]);
      if (reports.length + blocks.length !== input.items.length)
        throw TRPCBadRequestError(
          'All layout items must belong to this dashboard',
        );
      const blockKinds = new Map(blocks.map((block) => [block.id, block.kind]));
      const writes = input.items.map((item) => {
        const { minW, minH } =
          item.kind === 'report'
            ? { minW: 2, minH: 8 }
            : getDashboardBlockDefinition(blockKinds.get(item.id)!)
                .defaultLayout;
        if (item.h < minH) throw TRPCBadRequestError('Item is too short');
        if (item.w < minW) throw TRPCBadRequestError('Item is too narrow');
        if (item.kind === 'report') {
          const projected = toLegacyReportLayout({ ...item, minW, minH });
          const data = {
            ...projected,
            fineLayout: {
              ...projected.fineLayout,
              layout: { ...projected.fineLayout.layout },
            },
            maxW: projected.maxW ?? null,
            maxH: projected.maxH ?? null,
          };
          return db.reportLayout.upsert({
            where: { reportId: item.id },
            create: { reportId: item.id, ...data },
            update: data,
          });
        }
        return db.dashboardBlock.update({
          where: { id: item.id },
          data: {
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
            minW,
            minH,
          },
        });
      });
      // Keep changed items atomic without an interactive transaction deadline.
      if (writes.length > 0) await db.$transaction(writes);
      return { success: true };
    }),
  resetGridLayout: protectedProcedure
    .input(dashboardInput)
    .mutation(async ({ input, ctx }) => {
      await authorizeDashboard(input.dashboardId, ctx.session.userId);
      return db.$transaction(async (tx) => {
        await tx.reportLayout.deleteMany({
          where: { report: { dashboardId: input.dashboardId } },
        });
        const reportCount = await tx.report.count({
          where: { dashboardId: input.dashboardId },
        });
        const blocks = await tx.dashboardBlock.findMany({
          where: { dashboardId: input.dashboardId },
          orderBy: { createdAt: 'asc' },
        });
        let y = Math.ceil(reportCount / 3) * 16;
        for (const block of blocks) {
          const layout = getDashboardBlockDefinition(block.kind).defaultLayout;
          await tx.dashboardBlock.update({
            where: { id: block.id },
            data: { x: 0, y, ...layout },
          });
          y += layout.h;
        }
        return { success: true };
      });
    }),
};
