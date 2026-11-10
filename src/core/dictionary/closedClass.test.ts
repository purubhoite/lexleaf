import { describe, expect, it } from 'vitest';

import { closedClassEntry, closedClassKeys, hasClosedClassEntry } from './closedClass';

/**
 * The curated layer is application-authored content, so these tests are
 * about its contract rather than about any particular wording: it must
 * cover the function words a reader meets constantly, it must label them
 * with grammatical parts of speech, and it must never be mistaken for
 * WordNet material.
 */
describe('closed-class layer', () => {
  it.each([
    'the',
    'of',
    'and',
    'to',
    'that',
    'with',
    'from',
    'this',
    'their',
    'she',
    'they',
    'for',
  ])('covers %s', (word) => {
    expect(hasClosedClassEntry(word)).toBe(true);
  });

  it('covers the words WordNet answers with a chemical symbol', () => {
    for (const word of ['he', 'at', 'a']) {
      expect(hasClosedClassEntry(word)).toBe(true);
    }
  });

  it('describes words with grammatical parts of speech only', () => {
    const contentParts = new Set(['noun', 'verb', 'adjective', 'adverb']);

    for (const key of closedClassKeys()) {
      const entry = closedClassEntry(key);

      expect(entry).not.toBeNull();

      for (const sense of entry?.senses ?? []) {
        expect(contentParts.has(sense.partOfSpeech)).toBe(false);
      }
    }
  });

  it('gives every sense a definition and an illustration', () => {
    for (const key of closedClassKeys()) {
      for (const sense of closedClassEntry(key)?.senses ?? []) {
        expect(sense.definition.length).toBeGreaterThan(10);
        expect(sense.definition.endsWith('.')).toBe(true);
        expect(sense.examples).toHaveLength(1);
      }
    }
  });

  it('is keyed in lowercase, as the store is', () => {
    for (const key of closedClassKeys()) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  it('does not describe content words', () => {
    for (const word of ['book', 'run', 'lighthouse', 'happy']) {
      expect(hasClosedClassEntry(word)).toBe(false);
    }
  });

  it('returns null for an unknown key', () => {
    expect(closedClassEntry('zzz')).toBeNull();
  });
});
