import { defineConfig } from 'vitest/config';

// The replay logic under test is pure (no DOM), so plain Node is enough;
// the shared monorepo config runs tests in a browser.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
