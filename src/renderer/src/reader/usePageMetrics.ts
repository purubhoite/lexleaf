import { useEffect, useMemo, useState } from 'react';

import type { OpenedPdf } from '@core/pdf/pdfEngine';

import type { PageSize } from './model/pageLayout';

/**
 * How tall every page is.
 *
 * The scrolling surface cannot be laid out without this, and a document may
 * mix page sizes, so every page is measured — but not all at once and not
 * before the first page can be shown. Pages are measured in chunks, with the
 * first page's size standing in for those not yet measured, so the layout is
 * usable immediately and becomes exact a few frames later.
 *
 * Measuring is cheap (400 pages of the large fixture take ≈ 28 ms in Node),
 * which is why this is a background pass rather than an estimate the reader
 * has to live with.
 */

/** Pages measured between yields to the event loop. */
const CHUNK = 25;

export interface PageMetrics {
  /** Index 0 is page 1. Entries are the real size once measured. */
  readonly sizes: readonly PageSize[];
  readonly measured: number;
  /** The page fit modes are measured against: the largest one seen so far. */
  readonly reference: PageSize | null;
}

const DEFAULT_SIZE: PageSize = { width: 612, height: 792 };

interface Measured {
  /** The document these sizes were measured from. */
  readonly source: OpenedPdf | null;
  readonly sizes: readonly PageSize[];
}

export const usePageMetrics = (document: OpenedPdf | null, pageCount: number): PageMetrics => {
  const [measured, setMeasured] = useState<Measured>({ source: null, sizes: [] });

  useEffect(() => {
    if (document === null || pageCount <= 0) {
      return;
    }

    let cancelled = false;
    const sizes: PageSize[] = [];

    const measure = async (): Promise<void> => {
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const size = await document.getPageSize(pageNumber);

        if (cancelled) {
          return;
        }

        // A rotated page is presented rotated, so its laid-out box is the
        // rotated one; the engine reports the viewport, which already
        // accounts for /Rotate.
        sizes.push({ width: size.width, height: size.height });

        if (pageNumber % CHUNK === 0 || pageNumber === pageCount) {
          setMeasured({ source: document, sizes: [...sizes] });
          await new Promise((resolve) => setTimeout(resolve, 0));

          if (cancelled) {
            return;
          }
        }
      }
    };

    void measure().catch(() => undefined);

    return (): void => {
      cancelled = true;
    };
  }, [document, pageCount]);

  return useMemo<PageMetrics>(() => {
    if (pageCount <= 0) {
      return { sizes: [], measured: 0, reference: null };
    }

    // Sizes belonging to a document that is no longer open are simply not
    // used; they are never copied forward, so a switch cannot leave one
    // document laid out with another's page heights.
    const measuredSizes = measured.source === document ? measured.sizes : [];

    const fallback = measuredSizes[0] ?? DEFAULT_SIZE;
    const sizes = Array.from({ length: pageCount }, (_, index) => measuredSizes[index] ?? fallback);

    const reference = measuredSizes.reduce<PageSize | null>(
      (largest, size) =>
        largest === null || size.width * size.height > largest.width * largest.height
          ? size
          : largest,
      null,
    );

    return { sizes, measured: measuredSizes.length, reference: reference ?? fallback };
  }, [measured, document, pageCount]);
};
