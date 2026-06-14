import { FullPageEmptyState } from '@/components/full-page-empty-state';
import { Sidebar } from '@/components/sidebar';
import { Button, LinkButton, buttonVariants } from '@/components/ui/button';
import { useAppContext } from '@/hooks/use-app-context';
import { useSidebarCollapsed } from '@/hooks/use-sidebar-collapsed';
import { cn } from '@/utils/cn';
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { ConstructionIcon } from 'lucide-react';
import { useEffect } from 'react';

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context }) => {
    if (!context.session.session) {
      throw redirect({ to: '/login' });
    }
  },
  component: AppLayout,
});

function AppLayout() {
  const { isMaintenance } = useAppContext();
  const [collapsed] = useSidebarCollapsed();

  // The collapse is instant (content padding snaps). Width-measuring layouts
  // like react-grid-layout's WidthProvider only re-measure on window resize, so
  // nudge them on the next frame to reflow to the new content width.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `collapsed` is a trigger — the effect fires a resize when it changes rather than reading it.
  useEffect(() => {
    const id = setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 50);
    return () => clearTimeout(id);
  }, [collapsed]);

  if (isMaintenance) {
    return (
      <FullPageEmptyState
        icon={ConstructionIcon}
        className="min-h-screen"
        title="Maintenance mode"
        description="We are currently performing maintenance on the system. Please check back later."
      >
        <a
          href="https://status.openpanel.dev/"
          className={cn(buttonVariants())}
          target="_blank"
          rel="noopener noreferrer"
        >
          Check out our status page
        </a>
      </FullPageEmptyState>
    );
  }

  return (
    <div className="flex h-screen w-full">
      <Sidebar />
      <div className={cn('w-full', collapsed ? 'lg:pl-16' : 'lg:pl-72')}>
        <div className="block lg:hidden bg-background h-16 w-full fixed top-0 z-10 border-b" />
        <div className="block lg:hidden h-16" />
        <Outlet />
      </div>
    </div>
  );
}
