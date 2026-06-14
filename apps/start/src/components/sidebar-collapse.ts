// Tailwind utility groups for the collapsible sidebar.
// The sidebar root has `group/sidebar` + `data-collapsed="true|false"`, so these
// `group-data` variants only engage when collapsed AND at the `lg` breakpoint.

// Hide an element (label text, badge, etc.) when collapsed on desktop.
export const SB_HIDE = 'group-data-[collapsed=true]/sidebar:lg:hidden';

// Show an element ONLY when collapsed on desktop (e.g. section dividers).
export const SB_SHOW = 'hidden group-data-[collapsed=true]/sidebar:lg:block';

// Center an icon and drop horizontal padding when collapsed on desktop.
export const SB_CENTER =
  'group-data-[collapsed=true]/sidebar:lg:justify-center group-data-[collapsed=true]/sidebar:lg:px-0';
