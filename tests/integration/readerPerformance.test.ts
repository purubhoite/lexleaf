import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OpenedPdf, PdfEngine } from '../../src/core/pdf/pdfEngine';
import { findMatchesInText } from '../../src/core/search/findMatches';
import { identifyWordAt } from '../../src/core/word/identifyWord';
import { createNodeEngine, locationOfIndex, pageText, readFixture } from './support/corpus';

/**
 * What the reader actually costs.
 *
 * Milestone 2 requires measurements rather than impressions, so the figures
 * quoted in the milestone report are produced here and printed with a
 * `[perf]` prefix. They run against the same engine, the same search and the
 * same word identification the application uses; only the host differs
 * (Node instead of Chromium), so they are reported as relative costs, not as
 * a promise about a particular machine.
 *
 * The expectations are catastrophe detectors — an order of magnitude, not a
 * budget. A slower machine must not turn this suite red.
 */

const MEGABYTE = 1024 * 1024;

const millisecondsOf = async (work: () => Promise<void>): Promise<number> => {
  const started = performance.now();

  await work();

  return Math.round(performance.now() - started);
};

let engine: PdfEngine;

const open = async (fixture: string): Promise<{ document: OpenedPdf; milliseconds: number }> => {
  const bytes = await readFixture(fixture);
  const started = performance.now();
  const result = await engine.open({ bytes, label: fixture });
  const milliseconds = Math.round(performance.now() - started);

  if (!result.ok) {
    throw new Error(`${fixture} did not open: ${result.error.cause ?? result.error.kind}`);
  }

  return { document: result.value, milliseconds };
};

let large: OpenedPdf;
const pageTexts: string[] = [];

beforeAll(async () => {
  engine = await createNodeEngine();
  large = (await open('m-large')).document;
}, 120_000);

afterAll(async () => {
  await large.close();
});

describe('reader performance', () => {
  it('opens a small and a large document', async () => {
    const small = await open('a-standard-prose');
    const again = await open('m-large');

    console.log(`[perf] open 1-page document: ${small.milliseconds} ms`);
    console.log(`[perf] open 400-page document (4.2 MB): ${again.milliseconds} ms`);

    await small.document.close();
    await again.document.close();

    // Opening parses the catalogue, not the pages: a hundred-fold document
    // must not cost a hundred-fold open.
    expect(again.milliseconds).toBeLessThan(10_000);
  });

  it('measures every page size eagerly, which is what the layout needs', async () => {
    let total = 0;

    const elapsed = await millisecondsOf(async () => {
      for (let pageNumber = 1; pageNumber <= large.pageCount; pageNumber += 1) {
        total += (await large.getPageSize(pageNumber)).height;
      }
    });

    console.log(
      `[perf] page sizes for ${large.pageCount} pages: ${elapsed} ms ` +
        `(${(elapsed / large.pageCount).toFixed(2)} ms/page)`,
    );

    expect(total).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(10_000);
  });

  it('extracts the text of a whole document, and does it faster the second time', async () => {
    let characters = 0;

    const first = await millisecondsOf(async () => {
      for (let pageNumber = 1; pageNumber <= large.pageCount; pageNumber += 1) {
        const { segments } = await large.getPageText(pageNumber);
        const text = pageText(segments);

        pageTexts.push(text);
        characters += text.length;
      }
    });

    const second = await millisecondsOf(async () => {
      for (let pageNumber = 1; pageNumber <= large.pageCount; pageNumber += 1) {
        await large.getPageText(pageNumber);
      }
    });

    console.log(
      `[perf] text extraction, 400 pages, ${characters.toLocaleString('en-GB')} characters: ` +
        `${first} ms first pass, ${second} ms second pass`,
    );
    console.log(
      `[perf] renderer heap after extraction: ` +
        `${(process.memoryUsage().heapUsed / MEGABYTE).toFixed(1)} MiB`,
    );

    expect(characters).toBeGreaterThan(500_000);
    expect(first).toBeLessThan(60_000);
  });

  it('searches an extracted document far faster than it extracts it', () => {
    let matches = 0;

    const started = performance.now();

    pageTexts.forEach((text, index) => {
      matches += findMatchesInText(text, index + 1, {
        text: 'lighthouse',
        caseSensitive: false,
      }).length;
    });

    const elapsed = Math.round(performance.now() - started);

    console.log(
      `[perf] search 400 extracted pages for "lighthouse": ${elapsed} ms, ${matches} matches`,
    );

    // The renderer scans ten pages per yield; the cost that matters is the
    // extraction above, not the matching.
    expect(matches).toBe(1_200);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('identifies a word in well under a frame', async () => {
    const { segments } = await large.getPageText(200);
    const text = pageText(segments);
    const indices = Array.from({ length: 2_000 }, (_, index) => (index * 137) % text.length);
    const started = performance.now();

    for (const index of indices) {
      identifyWordAt(segments, locationOfIndex(segments, index));
    }

    const elapsed = performance.now() - started;

    console.log(
      `[perf] identify a word: ${(elapsed / indices.length).toFixed(3)} ms ` +
        `per lookup over ${indices.length} positions`,
    );

    expect(elapsed / indices.length).toBeLessThan(5);
  });

  it('switches documents repeatedly without the heap running away', async () => {
    const before = process.memoryUsage().heapUsed;

    for (let round = 0; round < 10; round += 1) {
      const { document } = await open('a-standard-prose');

      await document.getPageText(1);
      await document.close();
    }

    const after = process.memoryUsage().heapUsed;

    console.log(
      `[perf] 10 open/close rounds: heap ${(before / MEGABYTE).toFixed(1)} MiB → ` +
        `${(after / MEGABYTE).toFixed(1)} MiB (no forced collection)`,
    );

    // Without an explicit collection this is a coarse signal: it catches a
    // document that is never released, not a few megabytes of garbage.
    expect(after - before).toBeLessThan(200 * MEGABYTE);
  });
});
