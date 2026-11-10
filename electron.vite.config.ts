import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@core': resolve(__dirname, 'src/core'),
};

/**
 * Build configuration for the three Electron targets.
 *
 * Each target is bundled separately so that main-process code can never be
 * pulled into the renderer bundle (and vice versa).
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      minify: 'esbuild',
      sourcemap: true,
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      minify: 'esbuild',
      sourcemap: true,
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: { alias },
    build: {
      minify: 'esbuild',
      sourcemap: true,
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
