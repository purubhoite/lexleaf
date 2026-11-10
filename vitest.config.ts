import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Unit test configuration.
 *
 * Tests run in Node by default; renderer tests opt into jsdom with a
 * `@vitest-environment jsdom` docblock so that non-UI code is not slowed down
 * by a DOM implementation it does not need.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
    },
  },
  test: {
    environment: 'node',
    // Source-level tests (stylesheet structure, palette contrast) read files
    // and so live outside src/renderer, which may not reach the file system.
    // `.mjs` is here for one reason: the runtime harness under `scripts/`
    // is plain Node ES modules (it runs outside the bundler, beside the
    // other repository scripts), and the parts of it that can be decided
    // without an Electron process must be tested in the ordinary suite.
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.mjs',
    ],
    // jsdom lacks layout APIs the reader uses; the setup supplies inert
    // stand-ins so component tests fail for real reasons only.
    setupFiles: ['./tests/setup/jsdomPolyfills.ts'],
    // Refuses to start while a mutation campaign owns the working tree
    // (M7.4 G-c). An authorised subprocess of the campaign itself is
    // allowed through; see scripts/mutation/campaignLock.mjs.
    globalSetup: ['./tests/setup/mutationInterlock.mjs'],
    restoreMocks: true,
    reporters: ['default'],
  },
});
