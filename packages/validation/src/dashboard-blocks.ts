import { z } from 'zod';

export const dashboardBlockDefinitions = {
  text: {
    schema: z
      .object({ heading: z.string().max(500), body: z.string().max(50000) })
      .strict(),
    defaultConfig: { heading: '', body: '' },
    defaultLayout: { w: 12, h: 2, minW: 2, minH: 2 },
  },
  divider: {
    schema: z.object({}).strict(),
    defaultConfig: {},
    defaultLayout: { w: 12, h: 1, minW: 2, minH: 1 },
  },
};

export const dashboardBlockKindSchema = z.enum(['text', 'divider']);
export type DashboardBlockKind = z.infer<typeof dashboardBlockKindSchema>;

export const dashboardBlockSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    config: dashboardBlockDefinitions.text.schema,
  }),
  z.object({
    kind: z.literal('divider'),
    config: dashboardBlockDefinitions.divider.schema,
  }),
]);
export type DashboardBlockContent = z.infer<typeof dashboardBlockSchema>;

export function getDashboardBlockDefinition(kind: string) {
  return dashboardBlockDefinitions[dashboardBlockKindSchema.parse(kind)];
}

export function parseDashboardBlock(value: { kind: string; config: unknown }) {
  return dashboardBlockSchema.parse(value);
}
