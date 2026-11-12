/**
 * Where every page sits in the scrolling surface.
 *
 * This is the reader's geometry, and it is deliberately a pure function of
 * page sizes and a scale: nothing here reads the DOM, so the mapping between
 * a scroll offset and a reading position can be tested exactly, including the
 * cases that are awkward in a browser (pages of different heights, the first
 * and last page, a document shorter than the window).
 *
 * The scroll container itself remains the single source of truth for *where
 * the reader is* (ADR-017); this module only converts between that offset and
 * page coordinates.
 */

export interface PageSize {
  /** CSS pixels at 100 %. */
  readonly width: number;
  readonly height: number;
}

export interface LaidOutPage {
  readonly pageNumber: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /**
   * Where the page's left edge sits, measured from the centre line of the
   * pages. `null` for a page that is simply centred, which is every page
   * outside the two-page view.
   */
  readonly left: number | null;
}

/**
 * How pages are arranged.
 *
 * - `continuous`: one column, one page under another. What Lexleaf has
 *   always done.
 * - `single`: one page at a time. Each page has a slot at least as tall
 *   as the window, so only one is in view, and scrolling moves from one
 *   to the next.
 * - `two`: pages side by side in pairs, as an open book.
 */
export const PAGE_LAYOUT_MODES = ['continuous', 'single', 'two'] as const;

export type PageLayoutMode = (typeof PAGE_LAYOUT_MODES)[number];

export interface LayoutView {
  readonly mode: PageLayoutMode;
  /** The height of the window's document area; used by `single`. */
  readonly viewportHeight?: number;
}

export const CONTINUOUS_VIEW: LayoutView = { mode: 'continuous' };

export interface PageLayout {
  readonly pages: readonly LaidOutPage[];
  readonly totalHeight: number;
  /** Width of the widest page, used to centre the column. */
  readonly contentWidth: number;
  readonly scale: number;
  readonly gap: number;
}

export interface ReadingPoint {
  readonly page: number;
  /** 0 at the top of that page, 1 at its bottom. */
  readonly pageOffsetFraction: number;
}

/** Vertical space between two pages, in CSS pixels. */
export const PAGE_GAP = 20;

/*
 * Pairs of pages, side by side. Both pages of a pair start at the same
 * height, so the tops never decrease from one page to the next — which
 * the binary search in `pageAtOffset` depends on.
 */
const layOutSpreads = (sizes: readonly PageSize[], scale: number, gap: number): PageLayout => {
  const pages: LaidOutPage[] = [];
  let top = 0;
  let contentWidth = 0;

  for (let index = 0; index < sizes.length; index += 2) {
    const left = sizes[index];
    const right = sizes[index + 1];

    if (left === undefined) {
      break;
    }

    const leftWidth = left.width * scale;
    const leftHeight = left.height * scale;

    pages.push({
      pageNumber: index + 1,
      top,
      width: leftWidth,
      height: leftHeight,
      left: -(leftWidth + gap / 2),
    });

    // The last page of an odd-length book sits where a left page would.
    const rightWidth = right === undefined ? leftWidth : right.width * scale;
    const rightHeight = right === undefined ? 0 : right.height * scale;

    if (right !== undefined) {
      pages.push({
        pageNumber: index + 2,
        top,
        width: rightWidth,
        height: rightHeight,
        left: gap / 2,
      });
    }

    contentWidth = Math.max(contentWidth, 2 * Math.max(leftWidth, rightWidth) + gap);
    top += Math.max(leftHeight, rightHeight) + gap;
  }

  return { pages, totalHeight: Math.max(0, top - gap), contentWidth, scale, gap };
};

/**
 * Lays the pages out for a zoom and a view. Pure and cheap: it is run
 * again whenever either changes.
 */
export const createPageLayout = (
  sizes: readonly PageSize[],
  scale: number,
  gap: number = PAGE_GAP,
  view: LayoutView = CONTINUOUS_VIEW,
): PageLayout => {
  if (view.mode === 'two') {
    return layOutSpreads(sizes, scale, gap);
  }

  const pages: LaidOutPage[] = [];
  let top = 0;
  let contentWidth = 0;

  // One page at a time: every page gets a slot as tall as the window (or
  // as the page, if that is taller) and sits in the middle of it.
  const slot = view.mode === 'single' ? Math.max(0, view.viewportHeight ?? 0) : 0;

  for (const [index, size] of sizes.entries()) {
    const width = size.width * scale;
    const height = size.height * scale;
    const room = Math.max(height + gap, slot);
    const inset = view.mode === 'single' ? (room - height) / 2 : 0;

    pages.push({ pageNumber: index + 1, top: top + inset, width, height, left: null });
    contentWidth = Math.max(contentWidth, width);
    top += view.mode === 'single' ? room : height + gap;
  }

  return {
    pages,
    totalHeight: view.mode === 'single' ? top : Math.max(0, top - gap),
    contentWidth,
    scale,
    gap,
  };
};

/**
 * Where in the window the "page you are reading" is taken to be.
 *
 * Not the very top: when a page boundary crosses the top of the window the
 * reader is already reading the lower page, and an indicator that flips a
 * page early is worse than one that flips slightly late.
 */
export const READING_ANCHOR_FRACTION = 0.3;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

export const pageAt = (layout: PageLayout, pageNumber: number): LaidOutPage | null =>
  layout.pages[pageNumber - 1] ?? null;

/** The page whose band contains `offset`, clamped to the document. */
export const pageAtOffset = (layout: PageLayout, offset: number): number => {
  if (layout.pages.length === 0) {
    return 1;
  }

  // A binary search keeps scrolling in a 10,000-page document cheap.
  let low = 0;
  let high = layout.pages.length - 1;

  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    const page = layout.pages[middle];

    if (page !== undefined && page.top <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  // In the two-page view both pages of a pair start at the same height;
  // the pair is named by its first page.
  const found = layout.pages[low];

  if (found !== undefined && found.left !== null && found.left > 0) {
    return low;
  }

  return low + 1;
};

/** The page the reader is on, given where the window is. */
export const currentPageAt = (
  layout: PageLayout,
  scrollTop: number,
  viewportHeight: number,
): number => pageAtOffset(layout, scrollTop + viewportHeight * READING_ANCHOR_FRACTION);

/** Pages that intersect the window; both ends inclusive, 1-based. */
export const visiblePageRange = (
  layout: PageLayout,
  scrollTop: number,
  viewportHeight: number,
): { readonly first: number; readonly last: number } => {
  if (layout.pages.length === 0) {
    return { first: 1, last: 1 };
  }

  const first = pageAtOffset(layout, scrollTop);
  let last = first;

  while (last < layout.pages.length) {
    const page = layout.pages[last];

    if (page === undefined || page.top >= scrollTop + viewportHeight) {
      break;
    }

    last += 1;
  }

  return { first, last };
};

/** Turns a scroll offset into a position that survives a zoom change. */
export const positionAtOffset = (
  layout: PageLayout,
  scrollTop: number,
  viewportHeight: number,
): ReadingPoint => {
  const anchor = scrollTop + viewportHeight * READING_ANCHOR_FRACTION;
  const pageNumber = pageAtOffset(layout, anchor);
  const page = pageAt(layout, pageNumber);

  if (page === null || page.height === 0) {
    return { page: pageNumber, pageOffsetFraction: 0 };
  }

  return {
    page: pageNumber,
    pageOffsetFraction: clamp((anchor - page.top) / page.height, 0, 1),
  };
};

/**
 * The exact inverse of {@link positionAtOffset}, clamped to the document.
 *
 * Being an exact inverse is what makes "zoom, then find yourself in the same
 * place" true rather than approximately true.
 */
export const offsetOfPosition = (
  layout: PageLayout,
  position: ReadingPoint,
  viewportHeight: number,
): number => {
  const page = pageAt(layout, clamp(position.page, 1, Math.max(layout.pages.length, 1)));

  if (page === null) {
    return 0;
  }

  const anchor = page.top + clamp(position.pageOffsetFraction, 0, 1) * page.height;
  const maximum = Math.max(0, layout.totalHeight - viewportHeight);

  return clamp(anchor - viewportHeight * READING_ANCHOR_FRACTION, 0, maximum);
};

/** Scroll offset that puts the top of a page just below the window's top edge. */
export const offsetOfPageTop = (
  layout: PageLayout,
  pageNumber: number,
  viewportHeight: number,
): number => {
  const page = pageAt(layout, clamp(pageNumber, 1, Math.max(layout.pages.length, 1)));

  if (page === null) {
    return 0;
  }

  const maximum = Math.max(0, layout.totalHeight - viewportHeight);

  // Half a gap of air above the page, so it does not touch the toolbar.
  return clamp(page.top - layout.gap / 2, 0, maximum);
};
