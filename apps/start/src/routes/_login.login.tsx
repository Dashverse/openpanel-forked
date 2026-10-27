import { Or } from '@/components/auth/or';
import { SignInEmailForm } from '@/components/auth/sign-in-email-form';
import { SignInGoogle } from '@/components/auth/sign-in-google';
import { LogoSquare } from '@/components/logo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useTRPC } from '@/integrations/trpc/react';
import { PAGE_TITLES, createTitle } from '@/utils/title';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { AlertCircle } from 'lucide-react';
import { z } from 'zod';

export const Route = createFileRoute('/_login/login')({
  component: LoginPage,
  head: () => ({
    meta: [
      { title: createTitle(PAGE_TITLES.LOGIN) },
      { name: 'robots', content: 'noindex, follow' },
    ],
  }),
  validateSearch: z.object({
    error: z.string().optional(),
    correlationId: z.string().optional(),
    inviteId: z.string().optional(),
  }),
});

function LoginPage() {
  const { error, correlationId, inviteId } = Route.useSearch();
  const trpc = useTRPC();
  const { data: providers } = useQuery(trpc.auth.providers.queryOptions());

  return (
    <div className="col gap-8 w-full text-left">
      <div>
        <h1 className="text-3xl font-bold text-foreground mb-2">Sign in</h1>
        <p className="text-muted-foreground">
          Access is by invitation only. If you don't have access yet, ask an
          admin to invite you.
        </p>
      </div>
      {error && (
        <Alert
          variant="destructive"
          className="text-left bg-destructive/10 border-destructive/20 mb-6"
        >
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            {correlationId && (
              <>
                <p>Correlation ID: {correlationId}</p>
                <p className="mt-2">
                  Share this ID with an admin if the problem continues.
                </p>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-4">
        <SignInGoogle type="sign-in" inviteId={inviteId} />
      </div>
      {providers?.password && (
        <>
          <Or />
          <SignInEmailForm inviteId={inviteId} />
        </>
      )}
    </div>
  );
}
