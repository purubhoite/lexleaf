import { joinSegments } from '@core/word/identifyWord';

import type { TextLayerIndex } from './textLayerIndex';

/**
 * From a position in the page text back to the page on screen.
 *
 * Word identification goes DOM → text; highlighting a search match and
 * outlining the keyboard cursor need the opposite direction. Both are done
 * with a DOM `Range` over the text layer PDF.js produced, so the rectangles
 * are the browser's own measurements of the glyphs the reader can see — the
 * application still computes no PDF geometry of its own (AGENTS.md § 9).
 */

export interface HighlightRect {
  /** Relative to the page container, in CSS pixels. */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const firstTextNode = (element: Element | undefined): Text | null => {
  if (element === undefined) {
    return null;
  }

  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      return child as Text;
    }
  }

  return null;
};

interface NodePosition {
  readonly node: Text;
  readonly offset: number;
}

/** Locates an offset in the joined page text inside the text layer's DOM. */
const positionOf = (layer: TextLayerIndex, index: number): NodePosition | null => {
  const { segmentStarts } = joinSegments(layer.segments);

  for (let segmentIndex = layer.segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
    const start = segmentStarts[segmentIndex];
    const segment = layer.segments[segmentIndex];

    if (start === undefined || segment === undefined || index < start) {
      continue;
    }

    const offset = index - start;

    if (offset > segment.text.length) {
      // The index falls in the line break inserted after this segment.
      continue;
    }

    const node = firstTextNode(layer.elements[segmentIndex]);

    return node === null ? null : { node, offset: Math.min(offset, node.length) };
  }

  return null;
};

/**
 * A DOM range covering `[start, end)` of the joined page text.
 *
 * Returns `null` when either end cannot be placed — a tagged PDF whose
 * elements hold no direct text node, for instance. Callers draw nothing
 * rather than guessing at a rectangle.
 */
export const rangeForSpan = (
  ownerDocument: Document,
  layer: TextLayerIndex,
  start: number,
  end: number,
): Range | null => {
  const from = positionOf(layer, start);
  const to = positionOf(layer, Math.max(end, start));

  if (from === null || to === null) {
    return null;
  }

  const range = ownerDocument.createRange();

  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);

  return range;
};

/**
 * Rectangles covering a span, expressed relative to the page container.
 *
 * One rectangle per line the span crosses, which is what the browser already
 * reports for a range.
 */
export const rectsForSpan = (
  container: HTMLElement,
  layer: TextLayerIndex,
  start: number,
  end: number,
): HighlightRect[] => {
  const range = rangeForSpan(container.ownerDocument, layer, start, end);

  if (range === null) {
    return [];
  }

  const origin = container.getBoundingClientRect();
  const rects = [...range.getClientRects()].map((rect) => ({
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    width: rect.width,
    height: rect.height,
  }));

  range.detach();

  return rects.filter((rect) => rect.width > 0 && rect.height > 0);
};
