import { MinusIcon } from 'lucide-react';
import type { DashboardBlockView } from './types';

export const dividerBlockView: DashboardBlockView = {
  label: 'Divider',
  icon: MinusIcon,
  getSearchText: () => '',
  render: () => (
    <div
      className="flex h-full items-center pr-6"
      role="separator"
      aria-label="Dashboard section divider"
    >
      <div className="w-full border-t" />
    </div>
  ),
};
