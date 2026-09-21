import { cn } from '@/utils/cn';
import { ReportChartLoading } from './loading';

interface RefetchingOverlayProps {
  isRefetching: boolean;
}

// Single, consistent loader: on refetch we overlay the SAME "Stay calm, its
// coming" loader used for the initial load (ReportChartLoading), dimming the
// stale chart behind it — so the app never shows two different loader styles.
export function RefetchingOverlay({ isRefetching }: RefetchingOverlayProps) {
  if (!isRefetching) return null;

  return (
    <div
      className={cn(
        'absolute inset-0 z-10 flex items-center justify-center',
        'bg-background/60 backdrop-blur-[1px] rounded',
        'animate-in fade-in duration-200',
      )}
    >
      <ReportChartLoading />
    </div>
  );
}
