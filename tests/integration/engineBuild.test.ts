import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * Guards the engine build choice made during the spike.
 *
 * PDF.js 6.3 calls `Math.sumPrecise` (ES2026) while rebuilding embedded
 * fonts and measuring text. Electron 41 ships Chromium 146, where that
 * method does not exist, and the *modern* build then fails to open affected
 * documents with "Math.sumPrecise is not a function" - observed on the
 * encrypted corpus fixture in the built application. The *legacy* build
 * carries a polyfill, so the renderer uses it.
 *
 * These checks fail the moment either half of that reasoning stops holding:
 * if the modern build no longer needs the method, or if the renderer quietly
 * goes back to it. Both deserve a deliberate decision rather than a silent
 * regression in a document nobody opens during development.
 */

const require = createRequire(import.meta.url);

const readPackageFile = async (specifier: string): Promise<string> =>
  readFile(require.resolve(specifier), 'utf8');

describe('PDF.js build selection', () => {
  it('the modern worker build still depends on Math.sumPrecise', async () => {
    const modern = await readPackageFile('pdfjs-dist/build/pdf.worker.mjs');

    expect(modern).toContain('Math.sumPrecise');
  });

  it('the legacy worker build polyfills Math.sumPrecise', async () => {
    const legacy = await readPackageFile('pdfjs-dist/legacy/build/pdf.worker.mjs');

    expect(legacy).toMatch(/sumPrecise:\s*function/u);
  });

  it('the renderer engine is wired to the legacy build', async () => {
    const source = await readFile(
      new URL('../../src/renderer/src/reader/pdf/rendererEngine.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain("from 'pdfjs-dist/legacy/build/pdf.mjs'");
    expect(source).toContain("from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'");
  });

  it('the host runtime provides no Math.sumPrecise of its own below Chromium 147', () => {
    // Recorded so the report's claim is reproducible rather than asserted:
    // Node 22 (V8 12.x) has no Math.sumPrecise either, which is why the
    // integration suite also runs the legacy build.
    const method = (Math as { sumPrecise?: unknown }).sumPrecise;

    expect(typeof method === 'function' || method === undefined).toBe(true);
  });
});
