import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OpenedPdf, PdfEngine } from '../../src/core/pdf/pdfEngine';
import { identifyWordAt } from '../../src/core/word/identifyWord';
import { createNodeEngine, locationOfIndex, pageText, readFixture } from './support/corpus';

/**
 * Behaviour of the engine on a long document: page navigation, repeated
 * visits, and coarse performance figures for the spike report.
 *
 * The timings are observations, not thresholds; only a catastrophic
 * regression (an order of magnitude) would fail these tests.
 */

const MEGABYTE = 1024 * 1024;

const millisecondsOf = async (work: () => Promise<void>): Promise<number> => {
  const started = performance.now();
  await work();
  return Math.round(performance.now() - started);
};

let engine: PdfEngine;
let document: OpenedPdf;
let openMilliseconds = 0;

beforeAll(async () => {
  engine = await createNodeEngine();
  const bytes = await readFixture('m-large');

  const started = performance.now();
  const result = await engine.open({ bytes, label: 'm-large' });
  openMilliseconds = Math.round(performance.now() - started);

  if (!result.ok) {
    throw new Error(`m-large did not open: ${result.error.cause}`);
  }
  document = result.value;
});

afterAll(async () => {
  await document.close();
});

describe('M — a large document', () => {
  it('reports every page', () => {
    expect(document.pageCount).toBe(400);
    console.log(`[perf] open 400-page document: ${openMilliseconds} ms`);
  });

  it('identifies words on the first, a middle and the last page', async () => {
    for (const pageNumber of [1, 200, 400]) {
      const elapsed = await millisecondsOf(async () => {
        const { segments } = await document.getPageText(pageNumber);
        const text = pageText(segments);

        expect(text).toContain(`Page ${pageNumber}.`);
        expect(
          identifyWordAt(segments, locationOfIndex(segments, text.indexOf('lighthouse'))),
        ).toMatchObject({ raw: 'lighthouse' });
      });

      console.log(`[perf] text extraction page ${pageNumber}: ${elapsed} ms`);
    }
  });

  it('returns the same text when a page is revisited after navigating away', async () => {
    const first = await document.getPageText(7);
    await document.getPageText(390);
    const again = await document.getPageText(7);

    expect(again.segments).toEqual(first.segments);
    expect(pageText(again.segments)).toContain('Page 7.');
  });

  it('keeps page numbering independent of visit order', async () => {
    const forwards = await Promise.all(
      [1, 2, 3].map(async (page) => pageText((await document.getPageText(page)).segments)),
    );
    const backwards = await Promise.all(
      [3, 2, 1].map(async (page) => pageText((await document.getPageText(page)).segments)),
    );

    expect(backwards.reverse()).toEqual(forwards);
  });

  it('does not grow memory without bound while paging through the document', async () => {
    global.gc?.();
    const before = process.memoryUsage().heapUsed;

    for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
      await document.getPageText(pageNumber);
    }

    global.gc?.();
    const growth = (process.memoryUsage().heapUsed - before) / MEGABYTE;

    console.log(`[perf] heap growth after 100 pages of text extraction: ${growth.toFixed(1)} MiB`);
    expect(growth).toBeLessThan(512);
  });
});
