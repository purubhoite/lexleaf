import type { DictionaryResult } from '../dictionary/types';

import type { SavedDictionarySnapshot, SavedDictionarySource } from './types';

/**
 * The dictionary answer, frozen.
 *
 * A saved item stores **what the reader was shown**, not a reference to a
 * dictionary that can be upgraded, replaced or uninstalled underneath it
 * (ADR-025). Three rules follow and are enforced here rather than by
 * convention:
 *
 * - nothing is added that the popup did not render. The senses are the ones
 *   Milestone 3's pipeline already selected, in their order;
 * - nothing describing *where* the dictionary lives is copied — no artifact
 *   path, no byte offset into `entries.jsonl`, no index record number. Those
 *   are properties of one adapter's storage layout and are rebuilt on every
 *   dictionary update;
 * - a snapshot is never recomputed. This module can only ever be called on
 *   the way *in*; nothing in the product rewrites a stored snapshot.
 */

/** The provider id. One adapter ships today; the column exists for the next one. */
export const WORDNET_PROVIDER = 'wordnet';

/** Used when the artifact manifest cannot be read at the moment of saving. */
export const UNKNOWN_TRANSFORM_VERSION = 'unknown';

export const snapshotFrom = (result: DictionaryResult): SavedDictionarySnapshot | null => {
  if (result.status !== 'found' && result.status !== 'partial') {
    return null;
  }

  return {
    senses: result.senses.map((sense) => ({
      partOfSpeech: sense.partOfSpeech,
      definition: sense.definition,
      examples: [...sense.examples],
      synonyms: [...sense.synonyms],
      source: sense.source,
    })),
    pronunciations: result.pronunciations.map((pronunciation) => ({
      value: pronunciation.value,
      variety: pronunciation.variety,
    })),
    alsoInflectionOf: [...result.alsoInflectionOf],
  };
};

/**
 * The dictionary version a snapshot was taken from.
 *
 * Kept so the library can say which release a definition came from, and so
 * the licence and modification statement that applied at the time survive a
 * later artifact replacement.
 */
export const sourceFrom = (
  result: DictionaryResult,
  transformVersion: string,
): SavedDictionarySource | null => {
  if (result.status !== 'found' && result.status !== 'partial') {
    return null;
  }

  return {
    provider: WORDNET_PROVIDER,
    datasetName: result.attribution.datasetName,
    datasetRelease: result.attribution.release,
    transformVersion: transformVersion.length > 0 ? transformVersion : UNKNOWN_TRANSFORM_VERSION,
    attribution: result.attribution,
  };
};
