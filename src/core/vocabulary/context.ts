/**
 * The sentence a word was met in.
 *
 * Two things justify storing any document text at all: reminding the reader
 * where and how they met the word, and giving a later milestone something to
 * explain the word *in* without reopening the file. Everything else about
 * this module is a limit (ADR-026):
 *
 * - **240 characters, hard.** Enforced here and again by a `CHECK` in the
 *   schema, so no write path can exceed it. The cap is what keeps the
 *   vocabulary database from becoming a partial copy of the reader's library,
 *   and keeps a stored excerpt far away from any plausible reading of a
 *   "substantial part" of a work;
 * - **whole words only.** The window is grown outward from the saved word and
 *   then pulled back to the nearest whitespace boundary, so an excerpt never
 *   begins or ends inside a word;
 * - **one line.** Runs of whitespace — including the newlines the page text
 *   carries between text-layer runs — collapse to single spaces, so what is
 *   stored is what the library can show;
 * - **nothing when there is nothing.** No text layer, or a range that does
 *   not describe the text, yields `null` rather than a guess. A null context
 *   is a legal saved occurrence.
 */

/** The hard cap. Also expressed as a database `CHECK`. */
export const MAX_CONTEXT_CHARACTERS = 240;

export interface ExtractedContext {
  /** At most `MAX_CONTEXT_CHARACTERS` characters, whitespace collapsed. */
  readonly context: string;
  /** Where the saved word starts inside `context`. */
  readonly contextWordStart: number;
}

const WHITESPACE = /\s/u;
const WHITESPACE_RUN = /\s+/gu;

const collapse = (value: string): string => value.replace(WHITESPACE_RUN, ' ');

/** Pulls the left edge forward so the excerpt starts at a word boundary. */
const alignStart = (text: string, from: number, wordStart: number): number => {
  if (from === 0 || WHITESPACE.test(text.charAt(from - 1))) {
    return from;
  }

  for (let index = from; index < wordStart; index += 1) {
    if (WHITESPACE.test(text.charAt(index))) {
      return index + 1;
    }
  }

  return wordStart;
};

/** Pulls the right edge back so the excerpt ends at a word boundary. */
const alignEnd = (text: string, to: number, wordEnd: number): number => {
  if (to === text.length || WHITESPACE.test(text.charAt(to))) {
    return to;
  }

  for (let index = to; index > wordEnd; index -= 1) {
    if (WHITESPACE.test(text.charAt(index - 1))) {
      return index - 1;
    }
  }

  return wordEnd;
};

/**
 * Takes the excerpt around a word.
 *
 * @param joinedPageText the page text the word's range indexes into
 * @param start first character of the word, inclusive
 * @param end last character of the word, exclusive
 */
export const extractContext = (
  joinedPageText: string,
  start: number,
  end: number,
): ExtractedContext | null => {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return null;
  }

  if (start < 0 || end <= start || end > joinedPageText.length) {
    return null;
  }

  const word = collapse(joinedPageText.slice(start, end)).trim();

  if (word.length === 0 || word.length > MAX_CONTEXT_CHARACTERS) {
    return null;
  }

  const budget = MAX_CONTEXT_CHARACTERS - word.length;
  const leftAvailable = start;
  const rightAvailable = joinedPageText.length - end;

  let leftWanted = Math.floor(budget / 2);
  let rightWanted = budget - leftWanted;

  // A word near one edge of the page should still get a full-size excerpt,
  // so whatever one side cannot use is offered to the other.
  if (leftAvailable < leftWanted) {
    rightWanted += leftWanted - leftAvailable;
    leftWanted = leftAvailable;
  }

  if (rightAvailable < rightWanted) {
    leftWanted = Math.min(leftAvailable, leftWanted + (rightWanted - rightAvailable));
    rightWanted = rightAvailable;
  }

  const windowStart = alignStart(joinedPageText, start - leftWanted, start);
  const windowEnd = alignEnd(joinedPageText, end + rightWanted, end);

  const prefix = collapse(joinedPageText.slice(windowStart, start));
  const suffix = collapse(joinedPageText.slice(end, windowEnd));

  const joined = `${prefix}${word}${suffix}`;
  const leadingSpaces = joined.length - joined.trimStart().length;
  const context = joined.trim();
  const contextWordStart = prefix.length - leadingSpaces;

  if (context.length === 0 || context.length > MAX_CONTEXT_CHARACTERS) {
    return null;
  }

  if (contextWordStart < 0 || contextWordStart + word.length > context.length) {
    return null;
  }

  return { context, contextWordStart };
};
