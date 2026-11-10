/** What the reader typed, plus the only option the reader can change. */
export interface SearchQuery {
  readonly text: string;
  readonly caseSensitive: boolean;
}

/**
 * One occurrence of the query.
 *
 * `start` and `end` are offsets in the *joined page text* — the same
 * coordinate space word identification uses — so a match can be turned into a
 * DOM range in the text layer with the existing segment mapping, and nothing
 * has to reason about PDF coordinates.
 */
export interface SearchMatch {
  readonly pageNumber: number;
  readonly start: number;
  readonly end: number;
  /** A short, whitespace-collapsed excerpt for the results list. */
  readonly preview: string;
}
