import { joinSegments } from '@core/word/identifyWord';

import type { LivePage, PageRegistry } from '../interaction/pageRegistry';

import type { NewSelection } from './useAnnotations';

/**
 * Turns what the reader has selected with the pointer into places in the
 * pages' text.
 *
 * A selection is a start and an end in the document's elements. Each is
 * mapped to a page and an offset in that page's text; a selection that
 * runs across pages becomes one part for each page it touches. Anything
 * that does not land in a page's text — the gap between pages, the bar —
 * gives no parts at all, and nothing is offered.
 */

interface Place {
  readonly page: LivePage;
  readonly index: number;
}

const placeOf = (registry: PageRegistry, node: Node | null, offset: number): Place | null => {
  const page = registry.pageOfNode(node);

  if (page === null || node === null) {
    return null;
  }

  const { segmentStarts } = joinSegments(page.layer.segments);

  if (node.nodeType === Node.TEXT_NODE) {
    const element = node.parentElement;
    const segment = element === null ? undefined : page.layer.segmentOf.get(element);
    const start = segment === undefined ? undefined : segmentStarts[segment];

    return start === undefined ? null : { page, index: start + offset };
  }

  // An element: the selection begins or ends at one of its children.
  const element = node as Element;
  const own = page.layer.segmentOf.get(element);

  if (own !== undefined) {
    const start = segmentStarts[own] ?? 0;
    const length = page.layer.segments[own]?.text.length ?? 0;

    return { page, index: offset > 0 ? start + length : start };
  }

  const child = element.childNodes[offset] ?? null;
  const segment = child instanceof Element ? page.layer.segmentOf.get(child) : undefined;
  const start = segment === undefined ? undefined : segmentStarts[segment];

  if (start !== undefined) {
    return { page, index: start };
  }

  // Past the last child of the text layer: the end of the page's text.
  return element.contains(page.container) || page.container.contains(element)
    ? { page, index: offset === 0 ? 0 : joinSegments(page.layer.segments).text.length }
    : null;
};

const part = (page: LivePage, start: number, end: number): NewSelection | null => {
  const { text } = joinSegments(page.layer.segments);
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(0, Math.min(end, text.length));
  const slice = text.slice(from, to);

  // Trim the white space a drag picks up at either end, so the highlight
  // covers words and not the gap before them.
  const leading = slice.length - slice.trimStart().length;
  const trimmed = slice.trim();

  if (trimmed.length === 0) {
    return null;
  }

  return {
    page: page.pageNumber,
    start: from + leading,
    end: from + leading + trimmed.length,
    text: trimmed.replace(/\s+/gu, ' '),
  };
};

export interface SelectionEnds {
  readonly startNode: Node | null;
  readonly startOffset: number;
  readonly endNode: Node | null;
  readonly endOffset: number;
}

export const selectionParts = (ends: SelectionEnds, registry: PageRegistry): NewSelection[] => {
  const from = placeOf(registry, ends.startNode, ends.startOffset);
  const to = placeOf(registry, ends.endNode, ends.endOffset);

  if (from === null || to === null) {
    return [];
  }

  if (from.page.pageNumber === to.page.pageNumber) {
    const only = part(from.page, Math.min(from.index, to.index), Math.max(from.index, to.index));

    return only === null ? [] : [only];
  }

  const [first, last] = from.page.pageNumber < to.page.pageNumber ? [from, to] : [to, from];
  const parts: (NewSelection | null)[] = [part(first.page, first.index, Number.MAX_SAFE_INTEGER)];

  for (const page of registry.livePages()) {
    if (page.pageNumber > first.page.pageNumber && page.pageNumber < last.page.pageNumber) {
      parts.push(part(page, 0, Number.MAX_SAFE_INTEGER));
    }
  }

  parts.push(part(last.page, 0, last.index));

  return parts
    .filter((candidate): candidate is NewSelection => candidate !== null)
    .sort((left, right) => left.page - right.page);
};

/** The place in a page's text under a point on screen, if there is text there. */
export const textPlaceAtPoint = (
  ownerDocument: Document,
  registry: PageRegistry,
  clientX: number,
  clientY: number,
): { readonly page: number; readonly index: number } | null => {
  const caret = (
    ownerDocument as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    }
  ).caretRangeFromPoint?.(clientX, clientY);

  if (caret === null || caret === undefined) {
    return null;
  }

  const place = placeOf(registry, caret.startContainer, caret.startOffset);

  return place === null ? null : { page: place.page.pageNumber, index: place.index };
};
