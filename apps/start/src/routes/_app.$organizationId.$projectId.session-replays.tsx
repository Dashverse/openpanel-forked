import { SessionReplaysView } from '@/components/session-replays/session-replays-view';
import { PAGE_TITLES, createProjectTitle } from '@/utils/title';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';

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
  const { organizationId, projectId } = Route.useParams();

  // Session replays are recordings of real screens — they need the full window.
  // Render as a full-screen surface OVER the app nav sidebar (which would
  // otherwise eat ~240px), with a Back link out (the sidebar is hidden here).
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Link
          to="/$organizationId/$projectId"
          params={{ organizationId, projectId }}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          Back
        </Link>
        <span className="text-sm font-medium">Session Replays</span>
      </div>
      <div className="min-h-0 flex-1">
        <SessionReplaysView projectId={projectId} />
      </div>
    </div>
  );
}
