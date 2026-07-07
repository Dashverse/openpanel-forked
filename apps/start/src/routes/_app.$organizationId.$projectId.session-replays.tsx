import { PageContainer } from '@/components/page-container';
import { SessionReplaysView } from '@/components/session-replays/session-replays-view';
import { PAGE_TITLES, createProjectTitle } from '@/utils/title';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/session-replays',
)({
  component: Component,
  head: () => {
    return {
      meta: [
        {
          title: createProjectTitle(PAGE_TITLES.SESSION_REPLAYS),
        },
      ],
    };
  },
});

function Component() {
  const { projectId } = Route.useParams();

  return (
    <PageContainer fluid className="p-2">
      <SessionReplaysView projectId={projectId} />
    </PageContainer>
  );
}
