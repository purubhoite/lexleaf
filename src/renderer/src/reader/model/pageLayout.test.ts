import { describe, expect, it } from 'vitest';

import {
  createPageLayout,
  currentPageAt,
  offsetOfPageTop,
  offsetOfPosition,
  pageAt,
  pageAtOffset,
  positionAtOffset,
  visiblePageRange,
  PAGE_GAP,
  READING_ANCHOR_FRACTION,
  type PageSize,
} from './pageLayout';

const A4: PageSize = { width: 595, height: 842 };
const LETTER: PageSize = { width: 612, height: 792 };
const LANDSCAPE: PageSize = { width: 842, height: 595 };

const uniform = (count: number, scale = 1): ReturnType<typeof createPageLayout> =>
  createPageLayout(
    Array.from({ length: count }, () => A4),
    scale,
  );

const VIEWPORT = 800;

describe('page layout', () => {
  it('stacks pages with one gap between them and none after the last', () => {
    const layout = uniform(3);

    expect(layout.pages.map((page) => page.top)).toEqual([0, 862, 1_724]);
    expect(layout.totalHeight).toBe(842 * 3 + PAGE_GAP * 2);
    expect(layout.gap).toBe(PAGE_GAP);
  });

  it('scales every page and reports the widest one as the content width', () => {
    const layout = createPageLayout([A4, LANDSCAPE], 2);

    expect(layout.pages[0]).toMatchObject({ width: 1_190, height: 1_684, top: 0 });
    expect(layout.pages[1]?.top).toBe(1_684 + PAGE_GAP);
    expect(layout.contentWidth).toBe(1_684);
  });

  it('handles an empty document without pretending it has a page', () => {
    const layout = createPageLayout([], 1);

    expect(layout.pages).toEqual([]);
    expect(layout.totalHeight).toBe(0);
    expect(pageAt(layout, 1)).toBeNull();
    expect(pageAtOffset(layout, 500)).toBe(1);
    expect(visiblePageRange(layout, 0, VIEWPORT)).toEqual({ first: 1, last: 1 });
  });

  it('finds the page containing an offset, including the gaps and both ends', () => {
    const layout = uniform(5);

    expect(pageAtOffset(layout, 0)).toBe(1);
    expect(pageAtOffset(layout, 841)).toBe(1);
    // Inside the gap: still the page above, which is what the eye sees.
    expect(pageAtOffset(layout, 850)).toBe(1);
    expect(pageAtOffset(layout, 862)).toBe(2);
    expect(pageAtOffset(layout, -500)).toBe(1);
    expect(pageAtOffset(layout, 1_000_000)).toBe(5);
  });

  it('finds the page in a document whose pages have very different heights', () => {
    const layout = createPageLayout(
      [
        { width: 300, height: 100 },
        { width: 300, height: 4_000 },
        { width: 300, height: 120 },
      ],
      1,
    );

    expect(layout.pages.map((page) => page.top)).toEqual([0, 120, 4_140]);
    expect(pageAtOffset(layout, 50)).toBe(1);
    expect(pageAtOffset(layout, 2_000)).toBe(2);
    expect(pageAtOffset(layout, 4_200)).toBe(3);
  });

  it('calls the page under the reading anchor the current page, not the topmost one', () => {
    const layout = uniform(3);
    // 20 px of page 1 left on screen: the reader is reading page 2.
    const scrollTop = 842 - 20;

    expect(visiblePageRange(layout, scrollTop, VIEWPORT).first).toBe(1);
    expect(currentPageAt(layout, scrollTop, VIEWPORT)).toBe(2);
  });

  it('reports every page that intersects the window', () => {
    const layout = createPageLayout(
      Array.from({ length: 6 }, () => ({ width: 300, height: 200 })),
      1,
    );

    // A 700 px window over 220 px bands shows pages 1–4 (page 4 starts at 660).
    expect(visiblePageRange(layout, 0, 700)).toEqual({ first: 1, last: 4 });
    expect(visiblePageRange(layout, 0, 100)).toEqual({ first: 1, last: 1 });
    expect(visiblePageRange(layout, 1_200, 700)).toEqual({ first: 6, last: 6 });
  });

  it('describes a position as a page and a fraction of that page', () => {
    const layout = uniform(4);
    const anchor = VIEWPORT * READING_ANCHOR_FRACTION;
    const scrollTop = 862 + 421 - anchor; // halfway down page 2

    expect(positionAtOffset(layout, scrollTop, VIEWPORT)).toEqual({
      page: 2,
      pageOffsetFraction: 0.5,
    });
  });

  it('round-trips a position through an offset exactly', () => {
    const layout = uniform(10);

    for (const page of [1, 2, 7, 10]) {
      for (const fraction of [0, 0.25, 0.5, 0.9]) {
        const offset = offsetOfPosition(layout, { page, pageOffsetFraction: fraction }, VIEWPORT);
        const roundTripped = positionAtOffset(layout, offset, VIEWPORT);

        // The first and last pages clamp against the ends of the document;
        // everywhere else the conversion is exact.
        if (offset > 0 && offset < layout.totalHeight - VIEWPORT) {
          expect(roundTripped.page).toBe(page);
          expect(roundTripped.pageOffsetFraction).toBeCloseTo(fraction, 10);
        }
      }
    }
  });

  it('keeps the reading position across a zoom change', () => {
    const atOneHundred = uniform(12, 1);
    const atOneSeventyFive = uniform(12, 1.75);
    const position = { page: 6, pageOffsetFraction: 0.4 };

    const before = offsetOfPosition(atOneHundred, position, VIEWPORT);
    const after = offsetOfPosition(atOneSeventyFive, position, VIEWPORT);

    expect(positionAtOffset(atOneHundred, before, VIEWPORT).page).toBe(6);
    expect(positionAtOffset(atOneSeventyFive, after, VIEWPORT).page).toBe(6);
    expect(positionAtOffset(atOneSeventyFive, after, VIEWPORT).pageOffsetFraction).toBeCloseTo(
      0.4,
      10,
    );
  });

  it('never scrolls past either end of the document', () => {
    const layout = uniform(3);

    expect(offsetOfPosition(layout, { page: 1, pageOffsetFraction: 0 }, VIEWPORT)).toBe(0);
    expect(offsetOfPosition(layout, { page: 3, pageOffsetFraction: 1 }, VIEWPORT)).toBe(
      layout.totalHeight - VIEWPORT,
    );
    expect(offsetOfPosition(layout, { page: 99, pageOffsetFraction: 2 }, VIEWPORT)).toBe(
      layout.totalHeight - VIEWPORT,
    );
    expect(offsetOfPosition(layout, { page: -3, pageOffsetFraction: -1 }, VIEWPORT)).toBe(0);
  });

  it('does not scroll at all when the document is shorter than the window', () => {
    const layout = createPageLayout([LETTER], 1);

    expect(offsetOfPosition(layout, { page: 1, pageOffsetFraction: 1 }, 2_000)).toBe(0);
    expect(offsetOfPageTop(layout, 1, 2_000)).toBe(0);
  });

  it('puts half a gap of air above a page jumped to', () => {
    const layout = uniform(5);

    expect(offsetOfPageTop(layout, 3, VIEWPORT)).toBe(1_724 - PAGE_GAP / 2);
    expect(offsetOfPageTop(layout, 1, VIEWPORT)).toBe(0);
    // The last page still only needs its own top brought into view.
    expect(offsetOfPageTop(layout, 5, VIEWPORT)).toBe(862 * 4 - PAGE_GAP / 2);
    expect(offsetOfPageTop(layout, 5, VIEWPORT)).toBeLessThan(layout.totalHeight - VIEWPORT);
  });

  it('survives a page with no height, as a damaged document can produce', () => {
    const layout = createPageLayout([{ width: 0, height: 0 }, A4], 1);

    expect(positionAtOffset(layout, 0, 0)).toEqual({ page: 1, pageOffsetFraction: 0 });
    expect(offsetOfPosition(layout, { page: 1, pageOffsetFraction: 0.5 }, VIEWPORT)).toBe(0);
  });
});
