import type {
  DictionaryAttribution,
  DictionaryPartOfSpeech,
  DictionaryPronunciation,
  DictionaryResolution,
  DictionarySenseSource,
} from '../dictionary/types';

/**
 * The vocabulary port.
 *
 * Everything the rest of the application knows about saved words is in this
 * file: what a saved word is, what the places it was met are, what the
 * dictionary said at the time, and the operations a store must support. No
 * part of it mentions SQL, a file, a process or a rendering technology, so
 * the SQLite adapter can be replaced without any caller changing (ADR-021,
 * ADR-022, and section 16 of docs/VOCABULARY_INVESTIGATION.md).
 *
 * Two rules decide the shapes below and are worth stating once:
 *
 * - **identity is the normalised surface form** of the word as it appeared on
 *   the page, never the dictionary headword (ADR-024);
 * - **an occurrence is one word, in one document, on one page.** The
 *   character anchor is an attribute of that occurrence, not part of its
 *   identity, which is why `charStart`/`charEnd` are nullable here and are
 *   absent from the uniqueness key in the schema (section 10.4).
 */

/** The word as the reader met it, in the three forms Milestone 2 produces. */
export interface SavedWordForm {
  /** Exactly the characters on the page, line break included. Never altered. */
  readonly raw: string;
  /** What the popup titled; a line break is rendered as a hyphen. */
  readonly display: string;
  /** Identity: `normalizeWord(raw)` from `src/core/word/`. */
  readonly normalized: string;
  readonly joinedAcrossLines: boolean;
}

/**
 * What the dictionary made of the word when it was saved.
 *
 * `unavailable` is deliberately absent: a save preserves what the reader was
 * shown, and when the dictionary cannot answer at all there is nothing to
 * preserve. The popup offers no save control in that state.
 */
export type SavedLookupStatus = 'found' | 'partial' | 'not-found';

/** One sense exactly as the popup rendered it. */
export interface SavedSense {
  readonly partOfSpeech: DictionaryPartOfSpeech;
  readonly definition: string;
  readonly examples: readonly string[];
  readonly synonyms: readonly string[];
  /** Kept so third-party and application-authored material stay separable. */
  readonly source: DictionarySenseSource;
}

/**
 * The user-visible dictionary answer, frozen at the moment of saving.
 *
 * It is stored as one JSON column because it is a record of what a person was
 * shown, not queryable lexical data: modelling senses and synonyms as tables
 * would put the dictionary's schema inside the vocabulary store, which
 * Principle 3 forbids (ADR-025).
 */
export interface SavedDictionarySnapshot {
  readonly senses: readonly SavedSense[];
  readonly pronunciations: readonly DictionaryPronunciation[];
  readonly alsoInflectionOf: readonly string[];
}

/**
 * Which dictionary said it.
 *
 * Stored once per distinct version and referenced by items. Never a path, a
 * byte offset or an index record number: those describe where the artifact
 * lives on this machine and would make user data depend on a file that is
 * rebuilt from scratch on every dictionary update.
 */
export interface SavedDictionarySource {
  readonly provider: string;
  readonly datasetName: string;
  readonly datasetRelease: string;
  readonly transformVersion: string;
  readonly attribution: DictionaryAttribution;
}

/** One place a saved word was met: this document, this page. */
export interface SavedOccurrence {
  readonly documentId: string;
  readonly documentName: string;
  /** Null when the file behind the document is not where it was last seen. */
  readonly documentPath: string | null;
  readonly page: number;
  /** Character range in the joined page text. An attribute, not identity. */
  readonly charStart: number | null;
  readonly charEnd: number | null;
  readonly pageOffsetFraction: number | null;
  /** At most 240 characters, or null when no context was kept. */
  readonly context: string | null;
  readonly contextWordStart: number | null;
  readonly savedAt: string;
}

/** A saved word, with everything needed to understand it without the file. */
export interface SavedWord {
  readonly id: string;
  readonly word: SavedWordForm;
  readonly headword: string | null;
  readonly resolvedBy: DictionaryResolution | null;
  readonly lookupStatus: SavedLookupStatus;
  /** First sense, kept denormalised for the card and for tier-2 search. */
  readonly shortDefinition: string | null;
  readonly snapshot: SavedDictionarySnapshot | null;
  readonly source: SavedDictionarySource | null;
  readonly occurrences: readonly SavedOccurrence[];
  readonly savedAt: string;
  /** Places this word was saved from, counted as document pages. */
  readonly occurrenceCount: number;
}

/** The document a word was met in, as the vocabulary store records it. */
export interface SavedDocumentFacts {
  readonly id: string;
  readonly name: string;
  readonly path: string | null;
  readonly pageCount: number | null;
  readonly sizeBytes: number | null;
}

/** Where on a page a word was met. Everything but `page` is optional. */
export interface OccurrenceLocation {
  readonly page: number;
  readonly charStart: number | null;
  readonly charEnd: number | null;
  readonly pageOffsetFraction: number | null;
  readonly context: string | null;
  readonly contextWordStart: number | null;
}

/** Everything a save needs. Assembled by the renderer, validated at the IPC boundary. */
export interface SaveWordRequest {
  readonly word: SavedWordForm;
  readonly document: SavedDocumentFacts;
  readonly occurrence: OccurrenceLocation;
  readonly headword: string | null;
  readonly resolvedBy: DictionaryResolution | null;
  readonly lookupStatus: SavedLookupStatus;
  readonly shortDefinition: string | null;
  readonly snapshot: SavedDictionarySnapshot | null;
  readonly source: SavedDictionarySource | null;
}

/**
 * What the save control shows.
 *
 * Decided by `(normalizedWord, documentId, page)` and nothing else: a place
 * is a page, so a second encounter on the same page is the same occurrence.
 */
export type SavedWordState =
  | { readonly state: 'not-saved' }
  | { readonly state: 'saved-elsewhere'; readonly itemId: string; readonly otherPlaces: number }
  | { readonly state: 'saved-here'; readonly itemId: string; readonly otherPlaces: number };

/** Which word, in which document, on which page. No character range. */
export interface WordStateQuery {
  readonly normalized: string;
  readonly documentId: string;
  readonly page: number;
}

export type LibrarySort = 'newest' | 'oldest' | 'alphabetical';

/** Opaque to the renderer: it is handed back exactly as it was issued. */
export interface LibraryCursor {
  readonly sortKey: string;
  readonly id: string;
}

export interface LibraryQuery {
  readonly sort: LibrarySort;
  /** A single document id, or null for the whole library. */
  readonly documentId: string | null;
  readonly cursor: LibraryCursor | null;
  readonly limit: number;
}

export interface LibraryPage {
  readonly items: readonly SavedWord[];
  readonly nextCursor: LibraryCursor | null;
  /** Rows that failed validation and were skipped, never deleted. */
  readonly unreadable: number;
}

/** Counts per document, for the library's filter control. */
export interface DocumentFilterOption {
  readonly documentId: string;
  readonly name: string;
  readonly available: boolean;
  readonly count: number;
}

export interface SearchQuery {
  readonly query: string;
  readonly documentId: string | null;
  readonly limit: number;
}

/**
 * Search results, in two declared tiers.
 *
 * Tier 1 is a prefix match on the word, its display form or its headword;
 * tier 2 is a substring match inside the first definition and is only
 * searched for queries of three characters or more. A definition hit never
 * displaces a word hit, and nothing is scored.
 */
export interface SearchResults {
  readonly matches: readonly SavedWord[];
  readonly definitionMatches: readonly SavedWord[];
  /** True when the 200-row cap was reached and the list was cut. */
  readonly truncated: boolean;
  readonly unreadable: number;
}

/**
 * Why a vocabulary operation could not be performed.
 *
 * A closed union of reason codes and nothing else. No path, no SQL, no driver
 * message crosses the process boundary; the full error is logged main-side
 * (section 15.4).
 */
export type VocabularyUnavailableReason =
  | 'not-writable'
  | 'not-a-database'
  | 'corrupt'
  | 'locked'
  | 'schema-too-new'
  | 'migration-failed'
  | 'recovery-required'
  | 'unknown';

export type VocabularyFailure =
  | { readonly kind: 'unavailable'; readonly reason: VocabularyUnavailableReason }
  | { readonly kind: 'write-failed' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid-request' };

/**
 * The store, as the application depends on it.
 *
 * Implemented once, by the SQLite adapter in `src/main/vocabulary/`. Every
 * method answers with a value rather than throwing: a vocabulary database
 * that cannot be reached must never interrupt reading (Principle 7).
 */
export interface VocabularyRepository {
  stateForWord(query: WordStateQuery): SavedWordState;
  save(request: SaveWordRequest): SavedWord;
  /** One saved word, or null when it is not there. */
  find(itemId: string): SavedWord | null;
  remove(itemId: string): void;
  restore(item: SavedWord): void;
  list(query: LibraryQuery): LibraryPage;
  search(query: SearchQuery): SearchResults;
  occurrences(itemId: string): readonly SavedOccurrence[];
  documents(): readonly DocumentFilterOption[];
  close(): void;
}
