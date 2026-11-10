import { describe, expect, it } from 'vitest';

import {
  describeZoom,
  fitPageScale,
  fitWidthScale,
  fixedZoom,
  formatZoomPercentage,
  nextZoomLevel,
  previousZoomLevel,
  resolveScale,
  zoomWithMode,
  MAX_SCALE,
  MIN_SCALE,
  VIEWPORT_PADDING,
  ZOOM_LEVELS,
} from './zoom';
import type { PageSize } from './pageLayout';

const A4: PageSize = { width: 595, height: 842 };
const WINDOW = { width: 1_000, height: 800 };

describe('zoom', () => {
  it('offers seven levels from 50 % to 200 %', () => {
    expect([...ZOOM_LEVELS]).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  });

  it('steps up and down through the levels', () => {
    expect(nextZoomLevel(1)).toBe(1.25);
    expect(nextZoomLevel(0.5)).toBe(0.75);
    expect(previousZoomLevel(1)).toBe(0.75);
    expect(previousZoomLevel(2)).toBe(1.75);
  });

  it('steps to the neighbouring level from a fitted scale between two levels', () => {
    expect(nextZoomLevel(1.1)).toBe(1.25);
    expect(previousZoomLevel(1.1)).toBe(1);
  });

  it('stops at the ends rather than wrapping or growing without limit', () => {
    expect(nextZoomLevel(2)).toBe(MAX_SCALE);
    expect(nextZoomLevel(MAX_SCALE)).toBe(MAX_SCALE);
    expect(previousZoomLevel(0.5)).toBe(MIN_SCALE);
    expect(previousZoomLevel(MIN_SCALE)).toBe(MIN_SCALE);
  });

  it('fits the width of a page inside the window, leaving padding', () => {
    expect(fitWidthScale(A4, WINDOW)).toBeCloseTo((1_000 - VIEWPORT_PADDING) / 595, 10);
  });

  it('fits a whole page, choosing whichever dimension is tighter', () => {
    expect(fitPageScale(A4, WINDOW)).toBeCloseTo((800 - VIEWPORT_PADDING) / 842, 10);
    expect(fitPageScale({ width: 2_000, height: 100 }, WINDOW)).toBeCloseTo(
      (1_000 - VIEWPORT_PADDING) / 2_000,
      10,
    );
  });

  it('refuses to divide by a degenerate page size', () => {
    expect(fitWidthScale({ width: 0, height: 0 }, WINDOW)).toBe(1);
    expect(fitPageScale({ width: 0, height: 10 }, WINDOW)).toBe(1);
  });

  it('resolves a fixed zoom to its own scale, whatever the window', () => {
    expect(resolveScale(fixedZoom(1.5), A4, WINDOW)).toBe(1.5);
    expect(resolveScale(fixedZoom(1.5), A4, { width: 300, height: 300 })).toBe(1.5);
  });

  it('resolves fit modes against the reference page', () => {
    expect(resolveScale(zoomWithMode('fit-width', 1), A4, WINDOW)).toBeCloseTo(
      fitWidthScale(A4, WINDOW),
      10,
    );
    expect(resolveScale(zoomWithMode('fit-page', 1), A4, WINDOW)).toBeCloseTo(
      fitPageScale(A4, WINDOW),
      10,
    );
  });

  it('measures fit modes against the largest page, so scrolling never rescales', () => {
    const largest: PageSize = { width: 1_200, height: 600 };
    const scale = resolveScale(zoomWithMode('fit-width', 1), largest, WINDOW);

    // Every page, including the small ones, is drawn at the same scale.
    expect(scale).toBeCloseTo((1_000 - VIEWPORT_PADDING) / 1_200, 10);
    expect(scale).toBeLessThan(fitWidthScale(A4, WINDOW));
  });

  it('falls back to the stored scale before the document has been measured', () => {
    expect(resolveScale(fixedZoom(1.25), null, WINDOW)).toBe(1.25);
    expect(resolveScale(zoomWithMode('fit-width', 1.25), A4, { width: 0, height: 0 })).toBe(1.25);
  });

  it('clamps any scale it is handed, including a corrupt stored one', () => {
    expect(fixedZoom(99).scale).toBe(MAX_SCALE);
    expect(fixedZoom(0.001).scale).toBe(MIN_SCALE);
    expect(resolveScale(zoomWithMode('fit-width', 1), { width: 1, height: 1 }, WINDOW)).toBe(
      MAX_SCALE,
    );
  });

  it('labels the control with the intent and the resulting percentage', () => {
    expect(formatZoomPercentage(1.25)).toBe('125 %');
    expect(describeZoom(fixedZoom(1.5), 1.5)).toBe('150 %');
    expect(describeZoom(zoomWithMode('fit-width', 1), 1.37)).toBe('Fit width (137 %)');
    expect(describeZoom(zoomWithMode('fit-page', 1), 0.62)).toBe('Fit page (62 %)');
  });
});
