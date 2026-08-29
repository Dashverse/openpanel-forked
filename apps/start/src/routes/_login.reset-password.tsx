import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_login/reset-password')({
  beforeLoad: () => {
    throw redirect({ to: '/login' });
  },
});
