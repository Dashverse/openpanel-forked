import { createRouter as createTanstackRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import * as TanstackQuery from './integrations/tanstack-query/root-provider';

import { routeTree } from './routeTree.gen';
import { getServerEnvs } from './server/get-envs';

if (typeof window !== 'undefined') {
  // After a deploy the previous build's hashed chunks no longer exist on the
  // server, so tabs opened before the deploy fail dynamic imports on their
  // next navigation. Reload once to pick up the new build; the sessionStorage
  // guard prevents a reload loop if the chunk is still failing afterwards.
  window.addEventListener('vite:preloadError', (event) => {
    const key = 'op:chunk-reload';
    if (sessionStorage.getItem(key) === window.location.href) {
      return;
    }
    sessionStorage.setItem(key, window.location.href);
    event.preventDefault();
    window.location.reload();
  });
}

export const getRouter = async () => {
  const envs = await getServerEnvs();
  const rqContext = TanstackQuery.getContext(envs.apiUrl);

  const router = createTanstackRouter({
    routeTree,
    context: {
      ...rqContext,
      ...envs,
    },
    defaultPreload: 'intent',
    Wrap: (props: { children: React.ReactNode }) => {
      return (
        <TanstackQuery.Provider {...rqContext} apiUrl={envs.apiUrl}>
          {props.children}
        </TanstackQuery.Provider>
      );
    },
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient: rqContext.queryClient,
  });

  return router;
};

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
