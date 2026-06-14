import { cn } from '@/utils/cn';

interface PageContainerProps {
  className?: string;
  children: React.ReactNode;
  /**
   * Fill the full available width instead of capping at the responsive
   * `container` max-width. Useful for canvas-like pages (e.g. dashboards) that
   * should expand when the sidebar collapses.
   */
  fluid?: boolean;
}

export function PageContainer({
  className,
  children,
  fluid,
  ...props
}: PageContainerProps) {
  return (
    <div
      className={cn(fluid ? 'w-full p-8' : 'container p-8', className)}
      {...props}
    >
      {children}
    </div>
  );
}
