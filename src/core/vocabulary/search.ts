import { normalizeWord } from '../word/normalizeWord';

import type { LibraryCursor, LibrarySort, SavedWord } from './types';

/**
 * Finding a word in the library.
 *
 * The library is a few hundred to a few thousand of the reader's own words,
 * so this is finding, not relevance ranking: no full-text index, no fuzzy
 * matching, no stemming, no scoring (section 11). What is left is a handful
 * of rules, and they live here — pure, testable, and shared by every caller
 * so the renderer and the adapter cannot disagree about what a search means.
 */

/** Rows returned by one search, before the reader asks for more. */
export const MAX_SEARCH_RESULTS = 200;

/** Rows in one page of the library listing, paged with a keyset cursor. */
export const LIBRARY_PAGE_SIZE = 50;

/**
 * Below this, a query is too short to be worth matching inside definitions:
 * two characters match most of the dictionary and tell the reader nothing.
 */
export const MIN_DEFINITION_QUERY_LENGTH = 3;

/** The escape character declared by every `LIKE … ESCAPE` in the adapter. */
export const LIKE_ESCAPE = '\\';

/**
 * Makes a reader's text safe to use as a `LIKE` pattern.
 *
 * `%` and `_` are wildcards and the escape character escapes itself;
 * without this, searching for `a_b` would match `aXb` and searching for `%`
 * would return the whole library.
 */
export const escapeLikePattern = (value: string): string =>
  value.replace(/[\\%_]/gu, (character) => `${LIKE_ESCAPE}${character}`);

export interface SearchPlan {
  /** The reader's text, normalised by the one Unicode-aware normaliser. */
  readonly normalized: string;
  /** `LIKE` pattern for the prefix tier. */
  readonly prefixPattern: string;
  /**
   * `LIKE` pattern for the definition tier, or null when the query is too
   * short for substring matching to be useful.
   */
  readonly definitionPattern: string | null;
}

export type PreparedSearch =
  { readonly kind: 'listing' } | { readonly kind: 'search'; readonly plan: SearchPlan };

/**
 * Turns what the reader typed into the two patterns the adapter runs.
 *
 * An empty query is not a search — it is the default library listing, which
 * is a different query with different ordering. Normalisation is what makes
 * matching Unicode-correct: SQLite's `NOCASE` folds ASCII only, so `Café`
 * finds `café` because both sides go through `normalizeWord`, not because of
 * the collation.
 */
export const prepareSearch = (query: string): PreparedSearch => {
  const normalized = normalizeWord(query);

  if (normalized.length === 0) {
    return { kind: 'listing' };
  }

  const escaped = escapeLikePattern(normalized);

  return {
    kind: 'search',
    plan: {
      normalized,
      prefixPattern: `${escaped}%`,
      definitionPattern: normalized.length >= MIN_DEFINITION_QUERY_LENGTH ? `%${escaped}%` : null,
    },
  };
};

/** Keeps a renderer-supplied limit inside the declared bounds. */
export const clampLimit = (limit: number, maximum: number): number => {
  if (!Number.isFinite(limit) || limit < 1) {
    return maximum;
  }

  return Math.min(Math.floor(limit), maximum);
};

/**
 * The value a listing is sorted and paged by.
 *
 * Paging is keyset rather than `OFFSET`: the cursor is the last row's sort
 * key and id, so a save that happens while the reader is paging cannot make
 * a row appear twice or disappear.
 */
export const sortKeyOf = (item: SavedWord, sort: LibrarySort): string =>
  sort === 'alphabetical' ? item.word.display.toLowerCase() : item.savedAt;

export const cursorFor = (item: SavedWord, sort: LibrarySort): LibraryCursor => ({
  sortKey: sortKeyOf(item, sort),
  id: item.id,
});
