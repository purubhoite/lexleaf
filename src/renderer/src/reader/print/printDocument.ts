import type { PDFPageProxy } from 'pdfjs-dist';

import type { OpenedPdf } from '@core/pdf/pdfEngine';

/**
 * Printing.
 *
 * The window only ever draws the few pages near the reader, so it cannot
 * simply be printed as it stands. Instead every page asked for is drawn
 * once more, at print resolution, into a list of pictures that exists
 * only for the printer. At the moment of printing that list is shown and
 * everything else in the window is hidden; when printing is over the
 * window is put back and the list is thrown away.
 *
 * Pages are drawn one at a time and each is kept as a compressed picture,
 * so a long book costs time rather than memory. The work can be stopped
 * between any two pages.
 */

/** Print resolution, in dots per inch. A PDF's own unit is 1/72 inch. */
const PRINT_DPI = 150;
const PRINT_SCALE = PRINT_DPI / 72;
/** The longest side a print picture may have, so one huge page cannot exhaust memory. */
const MAX_SIDE = 4096;

export type PrintOutcome = 'printed' | 'cancelled' | 'failed';

export interface PrintRequest {
  readonly document: OpenedPdf;
  /** 1-based page numbers, in the order they are to be printed. */
  readonly pages: readonly number[];
  /** Quarter turns the reader has added, in degrees. */
  readonly rotation: number;
  readonly onProgress: (done: number, total: number) => void;
  readonly signal: AbortSignal;
  /**
   * The element the prepared pages go into. It is expected to be hidden
   * until `showForPrinting` is called.
   */
  readonly root: HTMLElement;
  /** Shows the prepared pages and hides the rest of the window, or undoes that. */
  readonly showForPrinting: (showing: boolean) => void;
  /** Opens the system's print window. Replaceable for tests. */
  readonly print?: () => void;
  /** How long to wait for the system to say printing is over. */
  readonly patience?: number;
}

/** The pages a range names, kept inside the book: "3–7" of 5 is 3, 4, 5. */
export const pagesInRange = (from: number, to: number, pageCount: number): number[] => {
  const first = Math.max(1, Math.min(Math.floor(from), Math.floor(to)));
  const last = Math.min(pageCount, Math.max(Math.floor(from), Math.floor(to)));

  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) {
    return [];
  }

  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
};

const drawPage = async (
  page: PDFPageProxy,
  rotation: number,
  canvas: HTMLCanvasElement,
): Promise<string> => {
  const natural = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
  const scale = Math.min(PRINT_SCALE, MAX_SIDE / Math.max(natural.width, natural.height));
  const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
  const context = canvas.getContext('2d');

  if (context === null) {
    throw new Error('No 2D canvas context.');
  }

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  // Paper is white; a page with a transparent background must not print black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvas, canvasContext: context, viewport }).promise;

  return canvas.toDataURL('image/jpeg', 0.92);
};

/**
 * Opens the print window and waits until printing is over.
 *
 * Chromium holds the page still while its print window is open, so the
 * call usually returns only afterwards. Where it returns at once, the
 * `afterprint` event says when; and a system that never says so is not
 * waited on for ever.
 */
const printAndWait = (print: () => void, patience: number): Promise<void> =>
  new Promise((resolve) => {
    let timer: number | null = null;

    const finish = (): void => {
      window.removeEventListener('afterprint', finish);

      if (timer !== null) {
        window.clearTimeout(timer);
      }

      resolve();
    };

    window.addEventListener('afterprint', finish);
    print();
    timer = window.setTimeout(finish, patience);
  });

export const printDocument = async ({
  document: pdfDocument,
  pages,
  rotation,
  onProgress,
  signal,
  root,
  showForPrinting,
  print = (): void => {
    window.print();
  },
  patience = 2000,
}: PrintRequest): Promise<PrintOutcome> => {
  if (pages.length === 0) {
    return 'failed';
  }

  const canvas = document.createElement('canvas');

  root.replaceChildren();

  try {
    for (const [index, pageNumber] of pages.entries()) {
      if (signal.aborted) {
        return 'cancelled';
      }

      onProgress(index, pages.length);

      const page = (await pdfDocument.getNativePage(pageNumber)) as PDFPageProxy;
      const image = document.createElement('img');

      image.className = root.dataset['pageClass'] ?? '';
      image.alt = '';
      image.src = await drawPage(page, rotation, canvas);
      root.append(image);

      // Let the window draw the progress and hear "Stop".
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (signal.aborted) {
      return 'cancelled';
    }

    onProgress(pages.length, pages.length);

    // Every picture must be decoded before the print window reads the page.
    await Promise.all(
      [...root.querySelectorAll('img')].map((image) =>
        typeof image.decode === 'function' ? image.decode().catch(() => undefined) : undefined,
      ),
    );

    showForPrinting(true);

    try {
      await printAndWait(print, patience);
    } finally {
      showForPrinting(false);
    }

    return 'printed';
  } catch {
    return 'failed';
  } finally {
    // The memory is released now rather than whenever it is collected.
    canvas.width = 0;
    canvas.height = 0;
    root.replaceChildren();
  }
};
