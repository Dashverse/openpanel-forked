import { PageHeader } from '@/components/page-header';
import { PAGE_TITLES, createProjectTitle } from '@/utils/title';
import { Outlet, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/profiles/_tabs',
)({
  component: Component,
  head: () => {
    return {
      meta: [
        {
          title: createProjectTitle(PAGE_TITLES.PROFILES),
        },
      ],
    };
  },
});

function Component() {
  return (
    <div className="container p-8">
      <PageHeader title="Profiles" />
      <div className="mt-8">
        <Outlet />
      </div>
    </div>
  );
}
