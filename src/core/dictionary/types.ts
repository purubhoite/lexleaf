/**
 * The dictionary port.
 *
 * Everything the rest of the application knows about definition lookup is in
 * this file: a query, four possible answers, and the provider that turns one
 * into the other. No part of it mentions a file, a path, a process or a
 * rendering technology, so the WordNet adapter can be replaced without any
 * caller changing (ADR-019).
 */

/**
 * The lookup request.
 *
 * `normalized` comes from `src/core/word/normalizeWord.ts` verbatim and is the
 * primary key. `raw` is kept because the page's own characters carry
 * information normalisation deliberately throws away — capitalisation, a
 * trailing abbreviation period, an apostrophe — and those are used to derive
 * additional lookup *keys*, never to re-normalise.
 */
export interface DictionaryQuery {
  /** `IdentifiedWord.normalized`: trimmed, case-folded, ligatures expanded. */
  readonly normalized: string;
  /** Exactly the characters on the page, line break included. */
  readonly raw: string;
  /** True when the word was reassembled across a hyphenated line break. */
  readonly joinedAcrossLines: boolean;
}

/**
 * Parts of speech the application can show.
 *
 * The first four are WordNet's. The rest exist because the curated
 * closed-class layer describes grammatical words WordNet does not cover, and
 * calling a determiner a noun would be a false statement about language.
 */
export type DictionaryPartOfSpeech =
  | 'noun'
  | 'verb'
  | 'adjective'
  | 'adverb'
  | 'determiner'
  | 'pronoun'
  | 'preposition'
  | 'conjunction'
  | 'auxiliary verb'
  | 'particle';

/**
 * Where a sense came from.
 *
 * Third-party material and application-authored material are never merged
 * into one undifferentiated list: the licence requires the first to be
 * attributed, and honesty requires the second not to be.
 */
export type DictionarySenseSource = 'wordnet' | 'application';

export interface DictionarySense {
  readonly partOfSpeech: DictionaryPartOfSpeech;
  readonly definition: string;
  /** Usage examples, empty when the source has none. Never invented. */
  readonly examples: readonly string[];
  /** Other words in the same sense, empty when the source has none. */
  readonly synonyms: readonly string[];
  readonly source: DictionarySenseSource;
}

/** A pronunciation exactly as published; never synthesised. */
export interface DictionaryPronunciation {
  /** IPA, as it appears in the source release. */
  readonly value: string;
  readonly variety: 'US' | 'GB' | 'unspecified';
}

/**
 * Which stage of the fallback pipeline produced the answer.
 *
 * The popup discloses anything other than `exact`, because a reader who
 * clicked "ran" is entitled to know they are reading the entry for "run".
 */
export type DictionaryResolution = 'exact' | 'case' | 'typographic' | 'morphology' | 'closed-class';

/** Optional fields that can be genuinely absent from the source data. */
export type DictionaryAbsentField = 'pronunciation' | 'examples' | 'synonyms';

/** Why no definition can be produced at all. A closed set. */
export type DictionaryUnavailableReason = 'not-installed' | 'unreadable' | 'corrupt';

/** Everything the in-app attribution affordance needs, from the manifest. */
export interface DictionaryAttribution {
  readonly datasetName: string;
  readonly release: string;
  readonly licences: readonly DictionaryLicence[];
  /** True when the application transformed the source data (it always does). */
  readonly modified: boolean;
  readonly modificationStatement: string;
  /** Credits owed to the upstream projects, shown verbatim. */
  readonly credits: readonly string[];
}

export interface DictionaryLicence {
  readonly name: string;
  readonly url: string;
}

interface DictionaryAnswerBase {
  /** The form the reader actually interacted with, for display. */
  readonly queried: string;
  /** The headword that answered, which may differ from `queried`. */
  readonly headword: string;
  readonly resolvedBy: DictionaryResolution;
  readonly senses: readonly DictionarySense[];
  readonly pronunciations: readonly DictionaryPronunciation[];
  /**
   * Headwords this word is also an inflected form of.
   *
   * Set when an exact entry exists *and* the word is a plausible inflection of
   * a different entry ("running" is a noun in its own right and also a form of
   * "run"). The exact entry stays primary; this is a subordinate disclosure.
   */
  readonly alsoInflectionOf: readonly string[];
  readonly attribution: DictionaryAttribution;
}

/** A complete answer: every optional field the source could supply is present. */
export interface DictionaryFound extends DictionaryAnswerBase {
  readonly status: 'found';
}

/**
 * An answer with something genuinely missing from the source.
 *
 * Marked rather than silently rendered as complete, so the interface can show
 * nothing instead of an empty placeholder, and so "no pronunciation" is never
 * mistaken for "pronunciation not loaded".
 */
export interface DictionaryPartial extends DictionaryAnswerBase {
  readonly status: 'partial';
  readonly absentFields: readonly DictionaryAbsentField[];
}

export interface DictionaryNotFound {
  readonly status: 'not-found';
  readonly queried: string;
  /** The keys the pipeline tried, in order. Diagnostic, not a suggestion. */
  readonly attempted: readonly string[];
}

/**
 * The dictionary itself could not answer.
 *
 * Carries a reason from a closed set and nothing else: no path, no `errno`,
 * no parser message. Those belong in main-process diagnostics.
 */
export interface DictionaryUnavailable {
  readonly status: 'unavailable';
  readonly reason: DictionaryUnavailableReason;
}

export type DictionaryResult =
  DictionaryFound | DictionaryPartial | DictionaryNotFound | DictionaryUnavailable;

/** The port the reader depends on. Implemented by the WordNet adapter. */
export interface DictionaryProvider {
  /** Never throws: an internal failure becomes an `unavailable` result. */
  lookUp(query: DictionaryQuery): DictionaryResult;
  /** Releases whatever the implementation holds open. Idempotent. */
  close(): void;
}

/* ------------------------------------------------------------------ *
 * Storage-facing types
 *
 * These describe what a *store* hands to the lookup pipeline. They are not
 * the result model: a stored sense knows its canonical spelling, which the
 * pipeline needs for case suppression but the reader never sees as such.
 * ------------------------------------------------------------------ */

export interface StoredSense {
  readonly partOfSpeech: DictionaryPartOfSpeech;
  readonly definition: string;
  readonly examples: readonly string[];
  readonly synonyms: readonly string[];
  /**
   * The spelling this sense is written with in the source data.
   *
   * "he" is stored under the lowercase key, but the source spells the helium
   * sense "He". That difference is the only signal needed to keep a chemical
   * symbol from answering a pronoun, and it comes from the data itself.
   */
  readonly writtenForm: string;
}

export interface StoredEntry {
  /** The lowercase lookup key this entry is stored under. */
  readonly key: string;
  readonly senses: readonly StoredSense[];
  readonly pronunciations: readonly DictionaryPronunciation[];
}

/**
 * Keyed access to dictionary entries.
 *
 * Deliberately tiny: an implementation can be a `Map` in a test or a binary
 * index over a payload file in production. `get` returns `null` both for
 * "absent" and for "present but malformed"; a malformed record must never
 * become a fabricated definition.
 */
export interface DictionaryStore {
  get(key: string): StoredEntry | null;
}

/** WordNet's morphological exception lists, one per part of speech. */
export interface MorphologyTables {
  readonly noun: ReadonlyMap<string, readonly string[]>;
  readonly verb: ReadonlyMap<string, readonly string[]>;
  readonly adjective: ReadonlyMap<string, readonly string[]>;
  readonly adverb: ReadonlyMap<string, readonly string[]>;
}

export const EMPTY_MORPHOLOGY_TABLES: MorphologyTables = {
  noun: new Map(),
  verb: new Map(),
  adjective: new Map(),
  adverb: new Map(),
};
