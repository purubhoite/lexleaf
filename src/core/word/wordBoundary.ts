/**
 * Deterministic word boundary detection over plain text.
 *
 * The rules are intentionally explicit rather than relying on a regular
 * expression such as `\b`, because the product has to behave predictably
 * around apostrophes, hyphens and Unicode punctuation.
 */

/** Letters, digits and combining marks are always part of a word. */
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}]/u;

/** Apostrophes: straight, typographic, and the modifier letter form. */
const APOSTROPHE = /['\u2019\u02BC\u2018]/u;

/** Hyphens that can join two halves of a single word. */
const HYPHEN = /[-\u2010\u2011]/u;

/** A character that joins word characters but is never a word on its own. */
const CONNECTOR = new RegExp(`${APOSTROPHE.source}|${HYPHEN.source}`, 'u');

export interface WordSpan {
  readonly text: string;
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
}

const charAt = (text: string, index: number): string | undefined =>
  index >= 0 && index < text.length ? text[index] : undefined;

const isWordCharacter = (char: string | undefined): boolean =>
  char !== undefined && WORD_CHARACTER.test(char);

const isConnector = (char: string | undefined): boolean =>
  char !== undefined && CONNECTOR.test(char);

export const isHyphen = (char: string | undefined): boolean =>
  char !== undefined && HYPHEN.test(char);

/**
 * Finds the word covering `index`.
 *
 * A caret offset sits *between* characters, so when the offset lands just
 * after the final character of a word (the common result of clicking the right
 * half of the last glyph) the preceding character is used. Clicking genuine
 * whitespace returns `null` — the product must never guess a word.
 */
export const findWordAt = (text: string, index: number): WordSpan | null => {
  if (index < 0 || index > text.length) {
    return null;
  }

  let anchor = index;
  if (!isWordCharacter(charAt(text, anchor))) {
    if (index > 0 && isWordCharacter(charAt(text, index - 1))) {
      anchor = index - 1;
    } else {
      return null;
    }
  }

  let start = anchor;
  while (start > 0) {
    const previous = charAt(text, start - 1);
    if (isWordCharacter(previous)) {
      start -= 1;
      continue;
    }
    // A connector only belongs to the word when a word character precedes it.
    if (isConnector(previous) && isWordCharacter(charAt(text, start - 2))) {
      start -= 2;
      continue;
    }
    break;
  }

  let end = anchor + 1;
  while (end < text.length) {
    const next = charAt(text, end);
    if (isWordCharacter(next)) {
      end += 1;
      continue;
    }
    if (isConnector(next) && isWordCharacter(charAt(text, end + 1))) {
      end += 2;
      continue;
    }
    break;
  }

  return { text: text.slice(start, end), start, end };
};
