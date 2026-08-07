import { defineEventHandler, setResponseHeader, setResponseStatus } from 'h3';

// Nitro's static middleware runs before route handlers, so this only fires
// when no file exists for the requested /assets/* path. Without it the
// request falls through to the SSR renderer, and the resulting HTML gets
// cached under the .js URL — since routeRules stamp /assets/** with a 1-year
// immutable cache-control, that poison would never expire (2026-07-08 prod
// incident). The 404 must be no-store so no cache layer remembers a
// transient deploy-window miss.
export default defineEventHandler((event) => {
  setResponseStatus(event, 404);
  setResponseHeader(event, 'cache-control', 'no-store');
  return 'Not found';
});
