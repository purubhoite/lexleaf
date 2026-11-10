import type { TextSegment } from '@core/word/types';

/**
 * The text layer, read back from the DOM.
 *
 * PDF.js builds the text layer as one element per text run, with a `<br>`
 * between visual lines. Reading the structure back from the DOM - instead of
 * recomputing it from coordinates - means the application works with exactly
 * what the user can see and select.
 */
export interface TextLayerIndex {
  readonly segments: readonly TextSegment[];
  /** Maps a text-layer element to its position in {@link segments}. */
  readonly segmentOf: ReadonlyMap<Element, number>;
  /**
   * The element each segment came from, by segment index.
   *
   * The inverse of {@link segmentOf}. Needed to go from a position in the
   * page text *back* to the DOM — which is what highlighting a search match
   * and outlining the keyboard cursor both require.
   */
  readonly elements: readonly Element[];
}

const MARKED_CONTENT = 'markedContent';

/**
 * Walks the text layer in document order.
 *
 * Marked content (tagged PDFs) nests elements, so the walk is recursive; the
 * resulting order still matches the reading order PDF.js produced.
 */
export const readTextLayer = (container: Element): TextLayerIndex => {
  const segments: TextSegment[] = [];
  const segmentOf = new Map<Element, number>();
  const elements: Element[] = [];

  const visit = (parent: Element): void => {
    for (const child of parent.children) {
      if (child.tagName === 'BR') {
        const last = segments.pop();

        if (last !== undefined) {
          segments.push({ text: last.text, endsLine: true });
        }
        continue;
      }

      if (child.classList.contains(MARKED_CONTENT)) {
        visit(child);
        continue;
      }

      segmentOf.set(child, segments.length);
      elements.push(child);
      segments.push({ text: child.textContent ?? '', endsLine: false });
    }
  };

  visit(container);

  return { segments, segmentOf, elements };
};
