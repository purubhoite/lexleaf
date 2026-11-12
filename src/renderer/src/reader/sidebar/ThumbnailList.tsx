import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';

import type { OpenedPdf } from '@core/pdf/pdfEngine';

import type { PageSize } from '../model/pageLayout';

/**
 * Small pictures of the pages, to find a place by eye.
 *
 * Every page has a button of the right shape from the start, so the list
 * has its full length and the scroll bar tells the truth. A page is only
 * drawn while its button is in or near view, and its picture is let go
 * when it scrolls away, so a thousand-page book costs no more than a
 * screenful of thumbnails.
 */

export const THUMBNAIL_WIDTH = 120;

export interface ThumbnailListProps {
  readonly document: OpenedPdf;
  /** Page sizes as they are shown, rotation already applied. */
  readonly sizes: readonly PageSize[];
  readonly rotation: number;
  readonly currentPage: number;
  readonly bookmarked: ReadonlySet<number>;
  readonly onGoToPage: (pageNumber: number) => void;
}

interface ThumbnailProps {
  readonly document: OpenedPdf;
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

const Thumbnail = ({
  document: pdfDocument,
  pageNumber,
  width,
  height,
  rotation,
}: ThumbnailProps): ReactElement => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (canvas === null) {
      return undefined;
    }

    let abandoned = false;
    let cancel = (): void => undefined;

    void (async (): Promise<void> => {
      try {
        const page = (await pdfDocument.getNativePage(pageNumber)) as PDFPageProxy;

        if (abandoned) {
          return;
        }

        const turned = (page.rotate + rotation) % 360;
        const natural = page.getViewport({ scale: 1, rotation: turned });
        const ratio = Math.min(window.devicePixelRatio, 2);
        const viewport = page.getViewport({
          scale: (width / natural.width) * ratio,
          rotation: turned,
        });
        const context = canvas.getContext('2d');

        if (context === null) {
          return;
        }

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);

        const task = page.render({ canvas, canvasContext: context, viewport });

        cancel = (): void => {
          task.cancel();
        };

        await task.promise;
      } catch {
        // A thumbnail that cannot be drawn stays blank; the number under
        // it still says which page it is.
      }
    })();

    return (): void => {
      abandoned = true;
      cancel();
    };
  }, [pdfDocument, pageNumber, width, rotation]);

  return (
    <canvas
      ref={canvasRef}
      className="thumbnails__canvas"
      style={{ width: `${String(width)}px`, height: `${String(height)}px` }}
    />
  );
};

export const ThumbnailList = ({
  document: pdfDocument,
  sizes,
  rotation,
  currentPage,
  bookmarked,
  onGoToPage,
}: ThumbnailListProps): ReactElement => {
  const listRef = useRef<HTMLOListElement>(null);
  const currentRef = useRef<HTMLLIElement | null>(null);
  const [near, setNear] = useState<ReadonlySet<number>>(new Set());

  // Which buttons are in or near view.
  useEffect(() => {
    const list = listRef.current;

    if (list === null || typeof IntersectionObserver === 'undefined') {
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setNear((before) => {
          const after = new Set(before);

          for (const entry of entries) {
            const pageNumber = Number((entry.target as HTMLElement).dataset['page']);

            if (entry.isIntersecting) {
              after.add(pageNumber);
            } else {
              after.delete(pageNumber);
            }
          }

          return after;
        });
      },
      { root: list.parentElement, rootMargin: '400px 0px' },
    );

    for (const item of list.children) {
      observer.observe(item);
    }

    return (): void => {
      observer.disconnect();
    };
  }, [sizes.length]);

  // The page being read stays in view in the list as the reader moves.
  useEffect(() => {
    const element = currentRef.current;

    if (element !== null && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [currentPage]);

  return (
    <ol className="thumbnails" ref={listRef} data-testid="thumbnails">
      {sizes.map((size, index) => {
        const pageNumber = index + 1;
        const height = Math.round((THUMBNAIL_WIDTH * size.height) / Math.max(size.width, 1));
        const isCurrent = pageNumber === currentPage;

        return (
          <li
            key={pageNumber}
            ref={isCurrent ? currentRef : null}
            className="thumbnails__item"
            data-page={pageNumber}
          >
            <button
              type="button"
              className={
                isCurrent ? 'thumbnails__page thumbnails__page--current' : 'thumbnails__page'
              }
              aria-label={`Page ${String(pageNumber)}${bookmarked.has(pageNumber) ? ', bookmarked' : ''}`}
              aria-current={isCurrent ? 'page' : undefined}
              data-testid="thumbnail"
              onClick={(): void => {
                onGoToPage(pageNumber);
              }}
            >
              <span
                className="thumbnails__sheet"
                style={{ width: `${String(THUMBNAIL_WIDTH)}px`, height: `${String(height)}px` }}
              >
                {near.has(pageNumber) && (
                  <Thumbnail
                    document={pdfDocument}
                    pageNumber={pageNumber}
                    width={THUMBNAIL_WIDTH}
                    height={height}
                    rotation={rotation}
                  />
                )}
                {bookmarked.has(pageNumber) && (
                  <span className="thumbnails__ribbon" aria-hidden="true" />
                )}
              </span>
              <span className="thumbnails__number" aria-hidden="true">
                {pageNumber}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
};
