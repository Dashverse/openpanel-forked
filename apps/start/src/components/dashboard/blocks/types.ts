import type { DashboardBlockContent } from '@openpanel/validation';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

export interface DashboardBlockEditorProps {
  block: DashboardBlockContent;
  onSave: (values: DashboardBlockContent) => Promise<unknown>;
  onClose: (restoreFocus?: boolean) => void;
}

export interface DashboardBlockView {
  label: string;
  icon: LucideIcon;
  render: (block: DashboardBlockContent) => ReactNode;
  getSearchText: (block: DashboardBlockContent) => string;
  Editor?: ComponentType<DashboardBlockEditorProps>;
}
