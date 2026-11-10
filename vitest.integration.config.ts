import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

/**
 * Integration test configuration.
 *
 * These tests drive the real PDF.js engine over the committed fixture corpus,
 * so they are slower than the unit suite and are kept in a separate project
 * that can be run on its own. No DOM: everything here is engine behaviour.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    restoreMocks: true,
    reporters: ['default'],
    // Refuses to start while a mutation campaign owns the working tree
    // (M7.4 G-c). An authorised subprocess of the campaign itself is
    // allowed through; see scripts/mutation/campaignLock.mjs.
    globalSetup: ['./tests/setup/mutationInterlock.mjs'],
    // PDF.js keeps worker state per process; one fork avoids cross-talk.
    pool: 'forks',
    fileParallelism: false,
  },
});
