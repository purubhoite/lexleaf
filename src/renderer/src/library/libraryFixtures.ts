import type { SavedOccurrence, SavedWord } from '@core/vocabulary/types';

/**
 * Saved words for the library tests.
 *
 * Kept in one place so the tests argue about behaviour rather than about
 * how to build a `SavedWord`, and so a change to the shape breaks one file
 * instead of five.
 */

export const anOccurrence = (patch: Partial<SavedOccurrence> = {}): SavedOccurrence => ({
  documentId: 'doc-a',
  documentName: 'Meditations.pdf',
  documentPath: null,
  page: 12,
  charStart: 40,
  charEnd: 48,
  pageOffsetFraction: 0.25,
  context: 'a sentence that held the word',
  contextWordStart: 11,
  savedAt: '2026-03-01T10:00:00.000Z',
  ...patch,
});

export const aSavedWord = (patch: Partial<SavedWord> = {}): SavedWord => ({
  id: 'item-1',
  word: {
    raw: 'equanimity',
    display: 'equanimity',
    normalized: 'equanimity',
    joinedAcrossLines: false,
  },
  headword: 'equanimity',
  resolvedBy: 'exact',
  lookupStatus: 'found',
  shortDefinition: 'steadiness of mind under stress',
  snapshot: {
    senses: [
      {
        partOfSpeech: 'noun',
        definition: 'steadiness of mind under stress',
        examples: [],
        synonyms: [],
        source: 'wordnet',
      },
    ],
    pronunciations: [],
    alsoInflectionOf: [],
  },
  source: null,
  occurrences: [anOccurrence()],
  savedAt: '2026-03-01T10:00:00.000Z',
  occurrenceCount: 1,
  ...patch,
});
