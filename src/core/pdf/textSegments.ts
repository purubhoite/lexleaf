import type { TextSegment } from '../word/types';

/**
 * The subset of a PDF.js text item this application depends on.
 *
 * Declaring it structurally keeps the conversion testable without PDF.js and
 * documents exactly how little of the engine's output is relied upon.
 */
export interface PdfTextItem {
  readonly str?: string;
  readonly hasEOL?: boolean;
}

/**
 * Converts raw text items into text-layer segments.
 *
 * The rule mirrors how PDF.js builds the text layer DOM: an item with text
 * becomes one element, and an item flagged `hasEOL` ends the current visual
 * line. Items carrying only an end-of-line flag (no text) therefore close the
 * previous segment instead of creating an empty one. Keeping the two
 * representations aligned is what allows a DOM hit test to be mapped back onto
 * this segment list.
 */
export const itemsToSegments = (items: readonly PdfTextItem[]): TextSegment[] => {
  const segments: TextSegment[] = [];

  for (const item of items) {
    if (item.str === undefined) {
      // Marked-content boundaries carry no text and no position.
      continue;
    }

    if (item.str === '') {
      if (item.hasEOL === true) {
        const last = segments.pop();
        if (last !== undefined) {
          segments.push({ text: last.text, endsLine: true });
        }
      }
      continue;
    }

    segments.push({ text: item.str, endsLine: item.hasEOL === true });
  }

  return segments;
};

/** True when a page offers nothing that could be hit tested. */
export const hasExtractableText = (segments: readonly TextSegment[]): boolean =>
  segments.some((segment) => segment.text.trim() !== '');
