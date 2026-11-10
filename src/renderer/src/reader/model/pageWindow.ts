/**
 * Which pages are allowed to exist.
 *
 * A continuously scrolling reader must not put a whole document into the DOM:
 * each live page costs a canvas (width × height × device pixel ratio × 4
 * bytes), a PDF.js text layer of one element per text run, and a page proxy
 * held open in the worker. The policy here is deliberate and bounded rather
 * than emergent (ADR-017).
 *
 * It is intentionally simple — a window around what is on screen — because
 * the measured cost of a page is low enough that cleverness would be harder
 * to trust than it is worth.
 */

export interface PageWindow {
  /** 1-based, inclusive. */
  readonly from: number;
  readonly to: number;
}

export interface PageWindowRequest {
  /** First and last page that intersect the window, 1-based inclusive. */
  readonly first: number;
  readonly last: number;
  readonly pageCount: number;
  /** Extra pages kept live on each side so scrolling does not reveal blanks. */
  readonly overscan?: number;
  readonly maxLivePages?: number;
}

/**
 * Pages kept beyond the visible band, on each side.
 *
 * One is enough to cover a flick of the wheel at reading speed; more mainly
 * buys memory consumption.
 */
export const DEFAULT_OVERSCAN = 1;

/**
 * Hard ceiling on simultaneously rendered pages.
 *
 * At 200 % zoom on A4 and a device pixel ratio of 2, one canvas is roughly
 * 1,190 × 1,684 CSS px → ≈ 32 MB of backing store. Seven pages is therefore
 * the point at which the canvases alone approach a quarter of a gigabyte,
 * which is as far as this reader is prepared to go; the window shrinks before
 * that only because the viewport rarely shows more than three pages at once.
 */
export const MAX_LIVE_PAGES = 7;

/**
 * @returns the inclusive range of pages that may be mounted
 */
export const livePageWindow = ({
  first,
  last,
  pageCount,
  overscan = DEFAULT_OVERSCAN,
  maxLivePages = MAX_LIVE_PAGES,
}: PageWindowRequest): PageWindow => {
  if (pageCount <= 0) {
    return { from: 1, to: 0 };
  }

  const visibleFirst = Math.min(Math.max(first, 1), pageCount);
  const visibleLast = Math.min(Math.max(last, visibleFirst), pageCount);

  let from = Math.max(1, visibleFirst - overscan);
  let to = Math.min(pageCount, visibleLast + overscan);

  // Trim the end furthest from what is actually on screen, so the pages a
  // reader is about to see survive and the ones they have left do not.
  while (to - from + 1 > maxLivePages) {
    const leadBefore = visibleFirst - from;
    const leadAfter = to - visibleLast;

    if (leadBefore >= leadAfter && from < visibleFirst) {
      from += 1;
    } else if (to > visibleLast) {
      to -= 1;
    } else {
      // The visible band itself exceeds the budget: keep its first pages.
      to -= 1;
    }
  }

  return { from, to };
};

export const pagesInWindow = ({ from, to }: PageWindow): number[] =>
  to < from ? [] : Array.from({ length: to - from + 1 }, (_, index) => from + index);

export const isPageLive = (window: PageWindow, pageNumber: number): boolean =>
  pageNumber >= window.from && pageNumber <= window.to;
