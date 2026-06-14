import { useCookieStore } from './use-cookie-store';

/**
 * Persisted, cross-component-reactive collapse state for the desktop sidebar.
 * Backed by a cookie so it survives reloads and is correct during SSR (no flash).
 * The collapse only affects the `lg` breakpoint and up — on smaller screens the
 * sidebar is a full-width drawer regardless of this flag.
 */
export function useSidebarCollapsed() {
  const [raw, setRaw] = useCookieStore('sidebar-collapsed', 'false');
  return [
    raw === 'true',
    (value: boolean) => setRaw(value ? 'true' : 'false'),
  ] as const;
}
