import { findWordAt, type WordSpan } from './wordBoundary';

/**
 * Moving from word to word inside a page's text.
 *
 * This is what makes a keyboard route to word identification possible without
 * a second word-identification algorithm: the cursor only *chooses an index*,
 * and the existing boundary rules (`findWordAt`) decide what a word is. A
 * keyboard user and a pointer user therefore reach `identifyWordAt` through
 * the same code, which is the requirement that stops the two paths drifting
 * apart.
 */

/**
 * The first word whose span begins at or after `from`.
 *
 * `from` may sit inside a word; that word is then skipped, because the caller
 * is asking to move on from it.
 */
export const nextWordFrom = (text: string, from: number): WordSpan | null => {
  const current = from >= 0 && from <= text.length ? findWordAt(text, from) : null;
  let index = current === null ? Math.max(from, -1) + 1 : current.end;

  while (index < text.length) {
    const span = findWordAt(text, index);

    // `findWordAt` steps back onto the previous word when the index sits just
    // past it, so a span that starts earlier than the search position is the
    // word being left behind, not the next one.
    if (span !== null && span.start >= index) {
      return span;
    }

    index += 1;
  }

  return null;
};

/** The last word that ends at or before `from`. */
export const previousWordFrom = (text: string, from: number): WordSpan | null => {
  const current = from >= 0 && from <= text.length ? findWordAt(text, from) : null;
  const limit = current === null ? Math.min(from, text.length) : current.start;
  let index = limit - 1;

  while (index >= 0) {
    const span = findWordAt(text, index);

    if (span !== null && span.end <= limit) {
      return span;
    }

    index -= 1;
  }

  return null;
};

export const firstWordOf = (text: string): WordSpan | null => nextWordFrom(text, -1);

/**
 * The last word on the page.
 *
 * The end of the text may sit *inside* the final word — it does whenever a
 * page ends without punctuation — and `previousWordFrom` would then treat
 * that word as the one being left behind and skip it. Asking for the word at
 * the very end first is what makes entering a page backwards land on its
 * last word rather than on the one before it.
 */
export const lastWordOf = (text: string): WordSpan | null =>
  findWordAt(text, text.length) ?? previousWordFrom(text, text.length);

/**
 * The word a keyboard cursor should land on when it enters a page.
 *
 * Entering forwards means starting at the top of the page; entering backwards
 * (shift-tabbing, or moving left off the start of the next page) means
 * starting at its end.
 */
export const wordOnEntry = (text: string, direction: 'forward' | 'backward'): WordSpan | null =>
  direction === 'forward' ? firstWordOf(text) : lastWordOf(text);
