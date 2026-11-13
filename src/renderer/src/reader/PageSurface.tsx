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
import { useSettledValue } from './useSettledValue';

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
  readonly kind: PageSpanKind;
  /** A highlight that carries a note is drawn with a line under it. */
  readonly noted?: boolean;
}

export type PageSpanKind =
  | 'match'
  | 'current-match'
  | 'cursor'
  | 'occurrence'
  | 'mark-yellow'
  | 'mark-green'
  | 'mark-blue'
  | 'mark-pink';

/*
 * Written out, one class to a kind, so that the stylesheet tests can see
 * that every kind has a rule and every rule a user.
 */
export const HIGHLIGHT_CLASS: Readonly<Record<PageSpanKind, string>> = {
  match: 'highlight highlight--match',
  'current-match': 'highlight highlight--current-match',
  cursor: 'highlight highlight--cursor',
  occurrence: 'highlight highlight--occurrence',
  'mark-yellow': 'highlight highlight--mark highlight--mark-yellow',
  'mark-green': 'highlight highlight--mark highlight--mark-green',
  'mark-blue': 'highlight highlight--mark highlight--mark-blue',
  'mark-pink': 'highlight highlight--mark highlight--mark-pink',
};

/** How long the zoom has to be still before the page is drawn again. */
const REDRAW_DELAY = 140;

export interface PageSurfaceProps {
  readonly document: OpenedPdf;
  readonly documentId: string;
  readonly pageNumber: number;
  readonly scale: number;
  /** Layout box, in CSS pixels. */
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** The left edge, from the centre line; `null` or absent for a centred page. */
  readonly left?: number | null;
  /** Quarter turns added by the reader, in degrees. */
  readonly rotation?: number;
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
  left = null,
  rotation = 0,
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
    readonly (HighlightRect & { kind: PageSpanKind; noted: boolean })[]
  >([]);
  // The scale the page is *drawn* at. It trails `scale` while the reader is
  // zooming; in between, what is already drawn is stretched to the new size.
  const drawnScale = useSettledValue(scale, REDRAW_DELAY);
  const stretch = drawnScale > 0 ? scale / drawnScale : 1;
  const stretchRef = useRef(stretch);

  useEffect(() => {
    stretchRef.current = stretch;
  }, [stretch]);
  // What the page last finished drawing for. Until it has drawn once there
  // is nothing to stretch, and the "Page N" placeholder is shown instead.
  const [drawnFor, setDrawnFor] = useState<{ document: OpenedPdf; rotation: number } | null>(null);
  const hasPicture =
    drawnFor !== null && drawnFor.document === pdfDocument && drawnFor.rotation === rotation;

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
          scale: drawnScale,
          pixelRatio: window.devicePixelRatio,
          rotation,
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
          scale: drawnScale,
          container,
          layer: rendered.layer,
        });

        dispatch({ type: 'rendered', generation });
        setDrawnFor({ document: pdfDocument, rotation });
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
    };
  }, [
    pdfDocument,
    documentId,
    pageNumber,
    drawnScale,
    rotation,
    registry,
    onRendered,
    onTextPresence,
  ]);

  // Highlights are measured from the rendered text layer, so they are
  // recomputed when the page finishes rendering and whenever the spans or
  // the scale change.
  useEffect(() => {
    const container = containerRef.current;
    const page = registry.get(pageNumber);

    if (spans.length === 0) {
      setHighlights([]);
      return;
    }

    // Between two drawings the marks already measured stay where they are,
    // and are stretched with the page, rather than blinking off and on.
    if (container === null || page === null || render.phase !== 'rendered') {
      return;
    }

    setHighlights(
      spans.flatMap((span) =>
        rectsForSpan(container, page.layer, span.start, span.end).map((rect) => ({
          // Measured on screen, where a page that is mid-zoom is stretched;
          // the marks live inside the stretched box, so that is taken out.
          left: rect.left / stretchRef.current,
          top: rect.top / stretchRef.current,
          width: rect.width / stretchRef.current,
          height: rect.height / stretchRef.current,
          kind: span.kind,
          noted: span.noted === true,
        })),
      ),
    );
  }, [spans, render.phase, render.generation, drawnScale, rotation, pageNumber, registry]);

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
        // Beside its neighbour in the two-page view; centred by the
        // stylesheet otherwise.
        ...(left === null ? {} : { left: `calc(50% + ${String(left)}px)`, transform: 'none' }),
      }}
      aria-label={`Page ${String(pageNumber)}`}
      role="img"
    >
      <div
        className="page__content"
        style={{
          width: `${String(width / stretch)}px`,
          height: `${String(height / stretch)}px`,
          ...(stretch === 1 ? {} : { transform: `scale(${String(stretch)})` }),
        }}
      >
        <canvas className="page__canvas" ref={canvasRef} />
        <div className="page__text textLayer" ref={textLayerRef} />

        <div className="page__highlights" aria-hidden="true">
          {highlights.map((rect, index) => (
            <span
              // Rectangles are positional and have no identity of their own.
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
      </div>

      {!hasPicture && render.phase !== 'rendered' && render.phase !== 'failed' && (
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
