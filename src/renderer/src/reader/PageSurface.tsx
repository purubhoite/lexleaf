import { useEffect, useReducer, useRef, useState, type ReactElement } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';

import { pageUnavailableMessage } from '@core/pdf/messages';
import type { OpenedPdf } from '@core/pdf/pdfEngine';

import {
  nextRenderGeneration,
  PAGE_NUMBER_ATTRIBUTE,
  type PageRegistry,
} from './interaction/pageRegistry';
import { initialPageRenderState, pageRenderReducer } from './model/pageLifecycle';
import { renderPage } from './pdf/renderPage';
import { rectsForSpan, type HighlightRect } from './pdf/textRanges';

/**
 * One page of the document, drawn and made interactive.
 *
 * The component owns a page's whole life: it starts a render when it is
 * mounted, publishes the resulting text layer to the page registry so
 * interactions can find it, draws whatever has to be highlighted on it, and
 * cancels and unpublishes everything when it is recycled.
 *
 * It knows nothing about scrolling, zoom intent, search or words. That is
 * what keeps "a page" a small, replaceable thing while several of them are
 * alive at once.
 */

/** A range of the page's text that should be marked. */
export interface PageSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: 'match' | 'current-match' | 'cursor' | 'occurrence';
}

export interface PageSurfaceProps {
  readonly document: OpenedPdf;
  readonly documentId: string;
  readonly pageNumber: number;
  readonly scale: number;
  /** Layout box, in CSS pixels. */
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly registry: PageRegistry;
  readonly spans: readonly PageSpan[];
  readonly showTextLayer: boolean;
  readonly onRendered: (pageNumber: number, milliseconds: number) => void;
  readonly onTextPresence: (pageNumber: number, hasText: boolean) => void;
}

export const PageSurface = ({
  document: pdfDocument,
  documentId,
  pageNumber,
  scale,
  top,
  width,
  height,
  registry,
  spans,
  showTextLayer,
  onRendered,
  onTextPresence,
}: PageSurfaceProps): ReactElement => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [render, dispatch] = useReducer(pageRenderReducer, initialPageRenderState);
  const [highlights, setHighlights] = useState<
    readonly (HighlightRect & { kind: PageSpan['kind'] })[]
  >([]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const textLayerContainer = textLayerRef.current;

    if (container === null || canvas === null || textLayerContainer === null) {
      return;
    }

    const generation = nextRenderGeneration();
    let abandoned = false;
    let cancel = (): void => undefined;

    dispatch({ type: 'start', generation });

    void (async (): Promise<void> => {
      const started = performance.now();

      try {
        // The only place that touches the engine's native page object; the
        // adapter hands it over precisely so rendering can happen here.
        const page = (await pdfDocument.getNativePage(pageNumber)) as PDFPageProxy;

        if (abandoned) {
          return;
        }

        const task = renderPage({
          page,
          canvas,
          textLayerContainer,
          scale,
          pixelRatio: window.devicePixelRatio,
        });

        cancel = (): void => {
          task.cancel();
        };

        const rendered = await task.completed;

        if (abandoned) {
          return;
        }

        // Published only now: a half-rendered layer must never be
        // interactive.
        registry.register({
          documentId,
          pageNumber,
          generation,
          scale,
          container,
          layer: rendered.layer,
        });

        dispatch({ type: 'rendered', generation });
        onRendered(pageNumber, Math.round(performance.now() - started));
        onTextPresence(
          pageNumber,
          rendered.layer.segments.some((segment) => segment.text.trim() !== ''),
        );
      } catch (error) {
        if (!abandoned) {
          dispatch({
            type: 'failed',
            generation,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return (): void => {
      // Abandoning here is what prevents a stale text layer from an earlier
      // page or zoom level being left behind, on screen or in the registry.
      abandoned = true;
      cancel();
      registry.release(pageNumber, generation);
      setHighlights([]);
    };
  }, [pdfDocument, documentId, pageNumber, scale, registry, onRendered, onTextPresence]);

  // Highlights are measured from the rendered text layer, so they are
  // recomputed when the page finishes rendering and whenever the spans or
  // the scale change.
  useEffect(() => {
    const container = containerRef.current;
    const page = registry.get(pageNumber);

    if (container === null || page === null || render.phase !== 'rendered' || spans.length === 0) {
      setHighlights([]);
      return;
    }

    setHighlights(
      spans.flatMap((span) =>
        rectsForSpan(container, page.layer, span.start, span.end).map((rect) => ({
          ...rect,
          kind: span.kind,
        })),
      ),
    );
  }, [spans, render.phase, render.generation, scale, pageNumber, registry]);

  const attributes = { [PAGE_NUMBER_ATTRIBUTE]: pageNumber };

  return (
    <div
      {...attributes}
      ref={containerRef}
      className={showTextLayer ? 'page page--show-text-layer' : 'page'}
      style={{
        top: `${String(top)}px`,
        width: `${String(width)}px`,
        height: `${String(height)}px`,
      }}
      aria-label={`Page ${String(pageNumber)}`}
      role="img"
    >
      <canvas className="page__canvas" ref={canvasRef} />
      <div className="page__text textLayer" ref={textLayerRef} />

      <div className="page__highlights" aria-hidden="true">
        {highlights.map((rect, index) => (
          <span
            // Rectangles are positional and have no identity of their own.
            key={`${rect.kind}:${String(index)}:${String(rect.left)}:${String(rect.top)}`}
            className={`highlight highlight--${rect.kind}`}
            style={{
              left: `${String(rect.left)}px`,
              top: `${String(rect.top)}px`,
              width: `${String(rect.width)}px`,
              height: `${String(rect.height)}px`,
            }}
          />
        ))}
      </div>

      {render.phase !== 'rendered' && render.phase !== 'failed' && (
        <p className="page__overlay">Page {pageNumber}</p>
      )}
      {render.phase === 'failed' && (
        // The engine's own words for the failure stay in the reducer state,
        // where the render lifecycle needs them to tell attempts apart; they
        // are deliberately not rendered. They can carry a file path, a
        // decoder internal or an exception, and a reader can act on none of
        // it (6.6 Part 0B).
        <p className="page__overlay page__overlay--problem" role="alert">
          {pageUnavailableMessage(pageNumber)}
        </p>
      )}
    </div>
  );
};
