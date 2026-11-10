/**
 * The one piece of coordinate arithmetic in the application.
 *
 * A caret position sits *between* two characters, so it cannot by itself say
 * which character the pointer is over: clicking the left half of "o" and the
 * right half of the preceding "d" can both report the same offset. The
 * browser also returns the *nearest* caret position even when the pointer is
 * past the end of a line, which would otherwise produce a word the user never
 * pointed at.
 *
 * This module resolves both cases by measuring the two candidate characters
 * and keeping the one whose box actually contains the pointer. The measuring
 * itself is injected, which keeps the decision testable without a layout
 * engine.
 */

export interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface CharacterPickRequest {
  /** Caret offset reported by the browser, in characters. */
  readonly caretOffset: number;
  /** Number of characters in the text run. */
  readonly length: number;
  readonly pointerX: number;
  readonly pointerY: number;
  /** Bounding box of a single character, in the same coordinate space. */
  readonly rectAt: (index: number) => Rect | null;
}

/**
 * Sub-pixel tolerance.
 *
 * Character boxes are fractional and the pointer position is rounded by the
 * browser, so an exact containment test would reject clicks that visually sit
 * on the glyph.
 */
const TOLERANCE = 0.5;

const contains = (rect: Rect, x: number, y: number): boolean =>
  x >= rect.left - TOLERANCE &&
  x <= rect.right + TOLERANCE &&
  y >= rect.top - TOLERANCE &&
  y <= rect.bottom + TOLERANCE;

/**
 * @returns the index of the character under the pointer, or null when the
 *          pointer is not over a character at all
 */
export const pickCharacterIndex = ({
  caretOffset,
  length,
  pointerX,
  pointerY,
  rectAt,
}: CharacterPickRequest): number | null => {
  // The character the caret precedes, then the one it follows.
  const candidates = [caretOffset, caretOffset - 1];

  for (const index of candidates) {
    if (index < 0 || index >= length) {
      continue;
    }

    const rect = rectAt(index);

    if (rect !== null && contains(rect, pointerX, pointerY)) {
      return index;
    }
  }

  return null;
};
