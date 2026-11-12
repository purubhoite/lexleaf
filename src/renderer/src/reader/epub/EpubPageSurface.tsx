import { useEffect, useRef, useState, type ReactElement } from 'react';

import { pageUnavailableMessage } from '@core/pdf/messages';

import {
  nextRenderGeneration,
  PAGE_NUMBER_ATTRIBUTE,
  type PageRegistry,
} from '../interaction/pageRegistry';
import { HIGHLIGHT_CLASS, type PageSpan, type PageSpanKind } from '../PageSurface';
import { rectsForSpan, type HighlightRect } from '../pdf/textRanges';

import { EPUB_TEXT_CLASS } from './chapter';
import { EPUB_PAGE_WIDTH, type OpenedEpub } from './epubDocument';

/**
 * One chapter of an EPUB, shown where a PDF page would be.
 *
 * The chapter is always set at the same width and type size, and then
 * scaled as a whole to the zoom the reader chose. Because nothing is set
 * again when the zoom changes, a chapter is exactly as many times taller
 * as it is wider, and the height measured once holds at every zoom.
 */

export interface EpubPageSurfaceProps {
  readonly document: OpenedEpub;
  readonly documentId: string;
  readonly pageNumber: number;
  readonly scale: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly registry: PageRegistry;
  readonly spans: readonly PageSpan[];
  readonly onTextPresence: (pageNumber: number, hasText: boolean) => void;
}

/**
 * How tall a chapter is at the standard width, with its pictures loaded.
 * It is set out of sight, measured, and taken away again.
 */
export const measureChapter = async (root: HTMLElement): Promise<number> => {
  const host = document.createElement('div');
  const body = document.createElement('div');

  host.className = 'epub-measure';
  body.className = 'epub';
  body.style.width = `${String(EPUB_PAGE_WIDTH)}px`;
  body.append(root.cloneNode(true));
  host.append(body);
  document.body.append(host);

  try {
    await Promise.all(
      [...body.querySelectorAll('img')].map((image) =>
        typeof image.decode === 'function' ? image.decode().catch(() => undefined) : undefined,
      ),
    );

    return body.getBoundingClientRect().height;
  } finally {
    host.remove();
  }
};

type Phase = 'loading' | 'shown' | 'failed';

export const EpubPageSurface = ({
  document: book,
  documentId,
  pageNumber,
  scale,
  top,
  width,
  height,
  registry,
  spans,
  onTextPresence,
}: EpubPageSurfaceProps): ReactElement => {
  const containerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<{ readonly generation: number; readonly phase: Phase }>({
    generation: 0,
    phase: 'loading',
  });
  const [highlights, setHighlights] = useState<
    readonly (HighlightRect & { kind: PageSpanKind; noted: boolean })[]
  >([]);

  useEffect(() => {
    const container = containerRef.current;
    const body = bodyRef.current;

    if (container === null || body === null) {
      return undefined;
    }

    const generation = nextRenderGeneration();
    let abandoned = false;

    setPhase({ generation, phase: 'loading' });

    void book.getChapter(pageNumber).then(
      (chapter) => {
        if (abandoned) {
          return;
        }

        body.replaceChildren(chapter.root.cloneNode(true));

        const elements = [...body.querySelectorAll(`.${EPUB_TEXT_CLASS}`)];

        registry.register({
          documentId,
          pageNumber,
          generation,
          scale,
          container,
          layer: {
            segments: chapter.segments,
            segmentOf: new Map(elements.map((element, index) => [element, index])),
            elements,
          },
        });

        setPhase({ generation, phase: 'shown' });
        onTextPresence(
          pageNumber,
          chapter.segments.some((segment) => segment.text.trim() !== ''),
        );
      },
      () => {
        if (!abandoned) {
          setPhase({ generation, phase: 'failed' });
        }
      },
    );

    return (): void => {
      abandoned = true;
      registry.release(pageNumber, generation);
      body.replaceChildren();
      setHighlights([]);
    };
  }, [book, documentId, pageNumber, scale, registry, onTextPresence]);

  useEffect(() => {
    const container = containerRef.current;
    const page = registry.get(pageNumber);

    if (container === null || page === null || phase.phase !== 'shown' || spans.length === 0) {
      setHighlights([]);

      return;
    }

    setHighlights(
      spans.flatMap((span) =>
        rectsForSpan(container, page.layer, span.start, span.end).map((rect) => ({
          ...rect,
          kind: span.kind,
          noted: span.noted === true,
        })),
      ),
    );
  }, [spans, phase, scale, pageNumber, registry]);

  const attributes = { [PAGE_NUMBER_ATTRIBUTE]: pageNumber };

  return (
    <div
      {...attributes}
      ref={containerRef}
      className="page page--epub"
      style={{
        top: `${String(top)}px`,
        width: `${String(width)}px`,
        height: `${String(height)}px`,
      }}
      aria-label={`Section ${String(pageNumber)}`}
      role="article"
    >
      <div
        ref={bodyRef}
        className="epub"
        style={{ width: `${String(EPUB_PAGE_WIDTH)}px`, transform: `scale(${String(scale)})` }}
      />

      <div className="page__highlights" aria-hidden="true">
        {highlights.map((rect, index) => (
          <span
            key={`${rect.kind}:${String(index)}:${String(rect.left)}:${String(rect.top)}`}
            className={
              rect.noted
                ? `${HIGHLIGHT_CLASS[rect.kind]} highlight--noted`
                : HIGHLIGHT_CLASS[rect.kind]
            }
            style={{
              left: `${String(rect.left)}px`,
              top: `${String(rect.top)}px`,
              width: `${String(rect.width)}px`,
              height: `${String(rect.height)}px`,
            }}
          />
        ))}
      </div>

      {phase.phase === 'failed' && (
        <p className="page__overlay page__overlay--problem" role="alert">
          {pageUnavailableMessage(pageNumber)}
        </p>
      )}
    </div>
  );
};
