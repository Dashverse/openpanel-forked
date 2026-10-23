import { ButtonContainer } from '@/components/button-container';
import { Button } from '@/components/ui/button';
import { useLogout } from '@/hooks/use-logout';
import { useTRPC } from '@/integrations/trpc/react';
import { useQuery } from '@tanstack/react-query';

/**
 * Shown to a signed-in user who cannot do anything yet: either they belong to
 * no organization (not invited), or they are a member who tried to create a
 * project without being an admin.
 */
export function NoAccess({ isMember }: { isMember: boolean }) {
  const trpc = useTRPC();
  const logout = useLogout();
  const { data: session } = useQuery(trpc.auth.session.queryOptions());

  return (
    <div className="col gap-4 p-6">
      <h2 className="text-xl font-semibold">
        {isMember
          ? 'Only admins can create projects'
          : "You don't have access yet"}
      </h2>
      <p className="text-muted-foreground">
        {isMember
          ? 'Ask an admin of your organization to create the project or to share an existing one with you.'
          : 'OpenPanel is invite-only. Ask an admin to invite you, then sign in again with the same account.'}
      </p>
      {session?.user?.email && (
        <p className="text-sm text-muted-foreground">
          Signed in as{' '}
          <span className="font-medium text-foreground">
            {session.user.email}
          </span>
        </p>
      )}
      <ButtonContainer>
        {isMember ? (
          <Button
            onClick={() => {
              window.location.href = '/';
            }}
          >
            Back to dashboard
          </Button>
        ) : (
          <div />
        )}
        <Button
          variant="outline"
          onClick={() => logout.mutate()}
          loading={logout.isPending}
        >
          Sign out
        </Button>
      </ButtonContainer>
    </div>
  );
}
