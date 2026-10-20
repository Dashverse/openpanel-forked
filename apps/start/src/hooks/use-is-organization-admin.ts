import { useTRPC } from '@/integrations/trpc/react';
import { useQuery } from '@tanstack/react-query';
import { useAppParams } from './use-app-params';

/**
 * Whether the signed-in user is an admin of the organization (the current
 * route's organization by default). Only for hiding UI: the server enforces
 * the same rule on every admin-only procedure.
 */
export function useIsOrganizationAdmin(organizationId?: string) {
  const trpc = useTRPC();
  const params = useAppParams();
  const id = organizationId ?? params.organizationId;
  const { data: organizations } = useQuery(
    trpc.organization.list.queryOptions(),
  );
  return !!organizations?.some(
    (organization) =>
      organization.id === id && organization.role === 'org:admin',
  );
}
