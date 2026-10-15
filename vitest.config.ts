import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests spawn the built CLI, so make sure dist/ is fresh first.
    globalSetup: ['test/global-setup.ts'],
  },
});
