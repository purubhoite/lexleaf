import { TextLayer, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';

import { readTextLayer, type TextLayerIndex } from './textLayerIndex';

/**
 * Draws one page: pixels onto a canvas, text into an overlay.
 *
 * The overlay is PDF.js's own text layer, positioned by PDF.js itself. The
 * application never computes glyph positions; it only reads the resulting
 * DOM.
 */

export interface RenderPageRequest {
  readonly page: PDFPageProxy;
  readonly canvas: HTMLCanvasElement;
  readonly textLayerContainer: HTMLElement;
  /** 1 means 100 %. */
  readonly scale: number;
  /** Device pixel ratio, so the canvas is sharp on high density displays. */
  readonly pixelRatio: number;
  /**
   * Quarter turns the reader has added, in degrees (0, 90, 180, 270). It
   * is added to whatever rotation the page itself declares.
   */
  readonly rotation?: number;
}

export interface RenderedPage {
  readonly width: number;
  readonly height: number;
  readonly layer: TextLayerIndex;
}

export interface PageRender {
  readonly completed: Promise<RenderedPage>;
  /** Stops an in-flight render; safe to call after completion. */
  cancel(): void;
}

const clearChildren = (element: HTMLElement): void => {
  while (element.firstChild !== null) {
    element.firstChild.remove();
  }
};

export const renderPage = ({
  page,
  canvas,
  textLayerContainer,
  scale,
  pixelRatio,
  rotation = 0,
}: RenderPageRequest): PageRender => {
  const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
  // The page is drawn out of sight and copied across when it is complete, so
  // that the picture already on screen stays there until its replacement is
  // ready instead of going blank for the length of the render.
  const scratch = canvas.ownerDocument.createElement('canvas');
  const context = scratch.getContext('2d');
  const visible = canvas.getContext('2d');

  if (context === null || visible === null) {
    return {
      completed: Promise.reject(new Error('This page cannot be drawn: no 2D canvas context.')),
      cancel: () => undefined,
    };
  }

  scratch.width = Math.floor(viewport.width * pixelRatio);
  scratch.height = Math.floor(viewport.height * pixelRatio);

  // PDF.js lays the text layer out in *unrotated* page space and then rotates
  // the whole container (see the `data-main-rotation` rules in reader.css), so
  // the container is sized from the raw page dimensions, not from the possibly
  // swapped viewport dimensions.
  const { pageWidth, pageHeight } = viewport.rawDims as {
    readonly pageWidth: number;
    readonly pageHeight: number;
  };

  // The text layer stylesheet multiplies every glyph height by the scale
  // factor, and PDF.js sizes the container with
  // `round(down, …, var(--scale-round-*))`. The old text stays in place,
  // under the old picture, until the new picture is ready (see below).
  textLayerContainer.style.setProperty('--scale-round-x', '1px');
  textLayerContainer.style.setProperty('--scale-round-y', '1px');

  let renderTask: RenderTask | null = null;
  let textLayer: TextLayer | null = null;
  let cancelled = false;

  const completed = (async (): Promise<RenderedPage> => {
    renderTask = page.render({
      canvas: scratch,
      canvasContext: context,
      viewport,
      transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
    });

    await renderTask.promise;

    if (cancelled) {
      throw new Error('Page render cancelled.');
    }

    // Sized by the stylesheet (it fills the page's box), so only the bitmap
    // changes here. Resizing a canvas clears it; the copy follows at once.
    canvas.width = scratch.width;
    canvas.height = scratch.height;
    visible.drawImage(scratch, 0, 0);
    // Let go of the scratch bitmap's memory straight away.
    scratch.width = 0;
    scratch.height = 0;

    clearChildren(textLayerContainer);
    textLayerContainer.style.width = `${pageWidth * scale}px`;
    textLayerContainer.style.height = `${pageHeight * scale}px`;
    textLayerContainer.style.setProperty('--total-scale-factor', `${scale}`);

    textLayer = new TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayerContainer,
      viewport,
    });

    await textLayer.render();

    return {
      width: viewport.width,
      height: viewport.height,
      layer: readTextLayer(textLayerContainer),
    };
  })();

  return {
    completed,
    cancel: (): void => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    },
  };
};
