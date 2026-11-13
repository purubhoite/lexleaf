import type { ZoomMode, ZoomState } from '@core/persistence/types';

import type { PageSize } from './pageLayout';

/**
 * How large pages are drawn.
 *
 * Zoom is stored as an *intent* (`fit-width`, `fit-page`, or a fixed level)
 * rather than as a number, because the two behave differently when the window
 * is resized: a fitted document must follow the window, a fixed level must
 * not. The resolved scale is derived, never stored as the authority.
 */

/** The levels offered in the zoom menu, as fractions. */
export const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

/** Breathing space around the page column, in CSS pixels. */
export const VIEWPORT_PADDING = 32;

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

const clampScale = (scale: number): number => Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);

/**
 * One press of zoom in or out, or one notch of the wheel: a single per cent.
 * A fitted scale is rarely a whole per cent, so the step starts from the
 * figure the reader sees in the toolbar, which is the rounded one.
 */
export const stepZoom = (scale: number, steps: number): number =>
  clampScale((Math.round(scale * 100) + steps) / 100);

export const nextZoomLevel = (scale: number): number => stepZoom(scale, 1);

export const previousZoomLevel = (scale: number): number => stepZoom(scale, -1);

export const fitWidthScale = (page: PageSize, viewport: ViewportSize): number =>
  page.width <= 0 ? 1 : clampScale((viewport.width - VIEWPORT_PADDING) / page.width);

export const fitPageScale = (page: PageSize, viewport: ViewportSize): number => {
  if (page.width <= 0 || page.height <= 0) {
    return 1;
  }

  return clampScale(
    Math.min(
      (viewport.width - VIEWPORT_PADDING) / page.width,
      (viewport.height - VIEWPORT_PADDING) / page.height,
    ),
  );
};

/**
 * Turns the stored intent into the scale to render at.
 *
 * @param reference the page the fit modes are measured against — the largest
 *                  page in the document, so that a document mixing portrait
 *                  and landscape pages never overflows sideways, and so the
 *                  scale does not change while scrolling
 */
export const resolveScale = (
  zoom: ZoomState,
  reference: PageSize | null,
  viewport: ViewportSize,
): number => {
  if (reference === null || viewport.width <= 0 || viewport.height <= 0) {
    return clampScale(zoom.scale);
  }

  switch (zoom.mode) {
    case 'fit-width':
      return fitWidthScale(reference, viewport);
    case 'fit-page':
      return fitPageScale(reference, viewport);
    case 'fixed':
      return clampScale(zoom.scale);
  }
};

export const fixedZoom = (scale: number): ZoomState => ({
  mode: 'fixed',
  scale: clampScale(scale),
});

export const zoomWithMode = (mode: ZoomMode, scale: number): ZoomState => ({
  mode,
  scale: clampScale(scale),
});

export const formatZoomPercentage = (scale: number): string =>
  `${String(Math.round(scale * 100))} %`;

/** Label for the zoom control, which shows the intent and the result. */
export const describeZoom = (zoom: ZoomState, scale: number): string => {
  switch (zoom.mode) {
    case 'fit-width':
      return `Fit width (${formatZoomPercentage(scale)})`;
    case 'fit-page':
      return `Fit page (${formatZoomPercentage(scale)})`;
    case 'fixed':
      return formatZoomPercentage(scale);
  }
};
