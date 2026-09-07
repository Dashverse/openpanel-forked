export const DASHBOARD_ROW_HEIGHT = 13;
export const DASHBOARD_CHART_MIN_HEIGHT = 8;
export const DASHBOARD_TEXT_MIN_HEIGHT = 2;
export const DASHBOARD_DIVIDER_MIN_HEIGHT = 1;

// Including the 16px gap, one legacy row spans exactly four fine rows.
const ROW_SCALE = 4;

export interface DashboardGridLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  minW: number;
  minH: number;
  maxW?: number;
  maxH?: number;
}

export interface LegacyReportLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number | null;
  minH?: number | null;
  maxW?: number | null;
  maxH?: number | null;
  fineLayout?: unknown;
}

const keys = ['x', 'y', 'w', 'h', 'minW', 'minH', 'maxW', 'maxH'] as const;

function isGridLayout(value: unknown): value is DashboardGridLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const layout = value as Record<string, unknown>;
  return keys.every((key) => {
    const number = layout[key];
    if ((key === 'maxW' || key === 'maxH') && number === undefined) return true;
    return (
      typeof number === 'number' &&
      Number.isSafeInteger(number) &&
      number >= (key === 'x' || key === 'y' ? 0 : 1)
    );
  });
}

function coordinates(layout: DashboardGridLayout): DashboardGridLayout {
  return {
    x: layout.x,
    y: layout.y,
    w: layout.w,
    h: layout.h,
    minW: layout.minW,
    minH: layout.minH,
    ...(layout.maxW === undefined ? {} : { maxW: layout.maxW }),
    ...(layout.maxH === undefined ? {} : { maxH: layout.maxH }),
  };
}

function readFineLayout(value: unknown, legacy: DashboardGridLayout) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const saved = value as Record<string, unknown>;
  // Old clients only write coarse coordinates, invalidating the saved fine layout.
  const snapshot = saved.legacy;
  if (
    saved.version !== 1 ||
    !isGridLayout(snapshot) ||
    !isGridLayout(saved.layout) ||
    !keys.every((key) => snapshot[key] === legacy[key])
  )
    return;
  return coordinates(saved.layout);
}

export function toFineReportLayout(
  reportId: string,
  legacyLayout: LegacyReportLayout | null | undefined,
  index: number,
): DashboardGridLayout & { id: string; kind: 'report' } {
  const position = Number.isSafeInteger(index) && index >= 0 ? index : 0;
  const defaults: DashboardGridLayout = {
    x: (position % 3) * 4,
    y: Math.floor(position / 3) * 4,
    w: 4,
    h: 4,
    minW: 2,
    minH: 2,
  };
  const candidate = legacyLayout
    ? {
        ...legacyLayout,
        minW: legacyLayout.minW ?? 2,
        minH: legacyLayout.minH ?? 2,
        maxW: legacyLayout.maxW ?? undefined,
        maxH: legacyLayout.maxH ?? undefined,
      }
    : defaults;
  const legacy = coordinates(isGridLayout(candidate) ? candidate : defaults);
  const fine = readFineLayout(legacyLayout?.fineLayout, legacy) ?? {
    ...legacy,
    y: legacy.y * ROW_SCALE,
    h: legacy.h * ROW_SCALE,
    minH: legacy.minH * ROW_SCALE,
    ...(legacy.maxH === undefined ? {} : { maxH: legacy.maxH * ROW_SCALE }),
  };
  return { id: reportId, kind: 'report', ...fine };
}

export function toLegacyReportLayout(fine: DashboardGridLayout) {
  if (!isGridLayout(fine)) throw new Error('Invalid dashboard grid layout');
  const layout = coordinates(fine);
  const legacy = {
    ...layout,
    y: Math.floor(layout.y / ROW_SCALE),
    h: Math.ceil(layout.h / ROW_SCALE),
    minH: Math.ceil(layout.minH / ROW_SCALE),
    ...(layout.maxH === undefined
      ? {}
      : { maxH: Math.ceil(layout.maxH / ROW_SCALE) }),
  };
  return {
    ...legacy,
    fineLayout: { version: 1, legacy: { ...legacy }, layout },
  };
}
