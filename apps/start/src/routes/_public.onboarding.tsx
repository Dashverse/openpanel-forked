import { Or } from '@/components/auth/or';
import { SignInGoogle } from '@/components/auth/sign-in-google';
import { SignUpEmailForm } from '@/components/auth/sign-up-email-form';
import FullPageLoadingState from '@/components/full-page-loading-state';
import { LogoSquare } from '@/components/logo';
import { useTRPC } from '@/integrations/trpc/react';
import { PAGE_TITLES, createEntityTitle } from '@/utils/title';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { MailIcon } from 'lucide-react';
import { z } from 'zod';
const validateSearch = z.object({
  inviteId: z.string().optional(),
});
export const Route = createFileRoute('/_public/onboarding')({
  head: () => ({
    meta: [
      { title: createEntityTitle('Accept invitation', PAGE_TITLES.ONBOARDING) },
      { name: 'robots', content: 'noindex, follow' },
    ],
  }),
  beforeLoad: async ({ context, search }) => {
    if (context.session.session) {
      throw redirect({ to: '/' });
    }
    // Accounts are only created from an invite link
    if (!(search as { inviteId?: string }).inviteId) {
      throw redirect({ to: '/login' });
    }
  },
  component: Component,
  validateSearch,
  loader: async ({ context, location }) => {
    const search = validateSearch.safeParse(location.search);
    if (search.success && search.data.inviteId) {
      await context.queryClient.prefetchQuery(
        context.trpc.organization.getInvite.queryOptions({
          inviteId: search.data.inviteId,
        }),
      );
    }
  },
  pendingComponent: FullPageLoadingState,
});

function Component() {
  const { inviteId } = Route.useSearch();
  const trpc = useTRPC();
  const { data: providers } = useQuery(trpc.auth.providers.queryOptions());
  const { data: invite } = useQuery(
    trpc.organization.getInvite.queryOptions(
      {
        inviteId: inviteId,
      },
      {
        enabled: !!inviteId,
      },
    ),
  );
  const isValid = !!invite?.id && !invite.isExpired;
  const loginHref = `/login?inviteId=${encodeURIComponent(inviteId ?? '')}`;

  return (
    <div className="col gap-8 w-full text-left">
      <div>
        <h1 className="text-3xl font-bold text-foreground mb-2">
          {isValid
            ? `Join ${invite.organization?.name ?? 'your team'}`
            : 'Invitation not valid'}
        </h1>
        <p className="text-muted-foreground">
          Already have an account?{' '}
          <a className="font-medium text-foreground underline" href={loginHref}>
            Sign in
          </a>{' '}
          and you will be added automatically.
        </p>
      </div>

      {isValid && (
        <div className="bg-card border border-border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-2">
            You have been invited to {invite.organization?.name}
          </h2>
          <p className="text-muted-foreground">
            Continue with the Google account for {invite.email} and you will
            land straight in the organization.
          </p>
        </div>
      )}
      {!isValid && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-2 text-destructive">
            {invite?.isExpired
              ? `Invitation to ${invite.organization?.name} has expired`
              : 'This invitation no longer exists'}
          </h2>
          <p className="text-muted-foreground">
            It may have been used already or revoked. Ask an admin to send you a
            new invitation.
          </p>
        </div>
      )}

      {isValid && (
        <div className="space-y-6">
          <SignInGoogle type="sign-up" inviteId={inviteId} />

          {providers?.passwordSignUp && (
            <>
              <Or className="my-6" />

              <div className="flex items-center gap-2 font-semibold mb-4 text-lg">
                <MailIcon className="size-4" />
                Or create a password
              </div>
              <SignUpEmailForm inviteId={inviteId} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
