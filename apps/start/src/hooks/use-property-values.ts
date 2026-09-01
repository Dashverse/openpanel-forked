import { useTRPC } from '@/integrations/trpc/react';
import { useQuery } from '@tanstack/react-query';

export function usePropertyValues(params: any) {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.chart.values.queryOptions(params, {
      enabled: !!params.projectId,
      // Filter-value dropdowns don't need real-time data. Without a staleTime,
      // React Query refetches on every window focus/remount — a dashboard tab
      // left open on a top-level-column filter (e.g. country) re-fires the
      // (slow, un-MV'd) chart.values query every focus, hammering ClickHouse
      // (one dashreels country dropdown burned ~320s / 768 GB of CH time in an
      // hour on this loop, every query timing out). Cache 1h + no focus refetch.
      staleTime: 60 * 60 * 1000,
      refetchOnWindowFocus: false,
    }),
  );
  return query.data?.values ?? [];
}
