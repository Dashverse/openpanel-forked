import type {
  DashboardBlockContent,
  DashboardBlockKind,
} from '@openpanel/validation';
import { dividerBlockView } from './divider';
import { textBlockView } from './text';
import type { DashboardBlockView } from './types';

export const dashboardBlockViews: Record<
  DashboardBlockKind,
  DashboardBlockView
> = {
  text: textBlockView,
  divider: dividerBlockView,
};

export function getDashboardBlockSearchText(block: DashboardBlockContent) {
  const view = dashboardBlockViews[block.kind];
  return `${block.kind} ${view.label} ${view.getSearchText(block)}`;
}
