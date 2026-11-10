import type { SearchMatch, SearchQuery } from './types';

/**
 * Finding a query in the text a page actually contains.
 *
 * This is deliberately *literal* search over extracted PDF text: no OCR, no
 * stemming, no fuzziness, no ranking, nothing that could surprise a reader
 * looking for a string they can see on the page. Two accommodations are made,
 * both forced by how PDFs store text rather than by cleverness:
 *
 * 1. a run of whitespace in the query matches any run of whitespace in the
 *    text, including the line breaks the text layer inserts, so a phrase
 *    still matches when the page broke it across two lines;
 * 2. typographic apostrophes are folded onto `'`, because a document shows
 *    "don't" while a keyboard produces "don't".
 *
 * Both folds preserve string length, so the offsets reported here remain
 * valid in the original page text.
 */

/** Characters either side of a match in the preview excerpt. */
const PREVIEW_CONTEXT = 32;

/** Refuses to report more than this on one page; protects a huge document. */
export const MAX_MATCHES_PER_PAGE = 500;

const TYPOGRAPHIC_APOSTROPHE = /[\u2019\u02BC\u2018]/gu;
const REGEXP_METACHARACTERS = /[.*+?^${}()|[\]\\]/gu;

/** Length-preserving: every replacement is one character for one character. */
const foldForSearch = (text: string): string => text.replace(TYPOGRAPHIC_APOSTROPHE, "'");

/** True when the query is worth running at all. */
export const isRunnableQuery = (query: SearchQuery): boolean => query.text.trim() !== '';

/**
 * Turns the query into a pattern.
 *
 * Everything is escaped first, so punctuation is matched literally; only
 * whitespace is then relaxed.
 */
export const buildSearchPattern = (query: SearchQuery): RegExp | null => {
  const trimmed = query.text.trim();

  if (trimmed === '') {
    return null;
  }

  const escaped = foldForSearch(trimmed)
    .replace(REGEXP_METACHARACTERS, '\\$&')
    .replace(/\s+/gu, '\\s+');

  return new RegExp(escaped, query.caseSensitive ? 'gu' : 'giu');
};

const previewAround = (text: string, start: number, end: number): string => {
  const from = Math.max(0, start - PREVIEW_CONTEXT);
  const to = Math.min(text.length, end + PREVIEW_CONTEXT);
  const excerpt = text.slice(from, to).replace(/\s+/gu, ' ').trim();

  return `${from > 0 ? '…' : ''}${excerpt}${to < text.length ? '…' : ''}`;
};

/**
 * @param text       joined text of one page
 * @param pageNumber the page that text came from
 */
export const findMatchesInText = (
  text: string,
  pageNumber: number,
  query: SearchQuery,
): SearchMatch[] => {
  const pattern = buildSearchPattern(query);

  if (pattern === null) {
    return [];
  }

  const haystack = foldForSearch(text);
  const matches: SearchMatch[] = [];
  let found = pattern.exec(haystack);

  while (found !== null && matches.length < MAX_MATCHES_PER_PAGE) {
    const start = found.index;
    const end = start + found[0].length;

    matches.push({ pageNumber, start, end, preview: previewAround(text, start, end) });

    // A zero-length match cannot happen with a non-empty pattern, but a
    // runaway loop here would freeze the UI, so the index is advanced anyway.
    pattern.lastIndex = end > start ? end : start + 1;
    found = pattern.exec(haystack);
  }

  return matches;
};

/** Index of the match a reader should land on when they search again from `page`. */
export const firstMatchFromPage = (
  matches: readonly SearchMatch[],
  page: number,
): number | null => {
  if (matches.length === 0) {
    return null;
  }

  const index = matches.findIndex((match) => match.pageNumber >= page);

  return index === -1 ? 0 : index;
};

/** Moves through the match list, wrapping at both ends. */
export const stepMatch = (total: number, current: number, step: 1 | -1): number => {
  if (total <= 0) {
    return 0;
  }

  return (current + step + total) % total;
};
