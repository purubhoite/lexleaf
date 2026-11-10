import { describe, expect, it } from 'vitest';

import type { DictionaryResult } from '@core/dictionary/types';
import { openWordNetProvider } from '@core/dictionary/wordnet/wordNetFileProvider';

import { DICTIONARY_FIXTURE_DIR } from '../../../tests/support/dictionaryFixture';

import { openFileArtifact } from './fileArtifact';

/**
 * The content-quality regressions.
 *
 * These are the answers that decide whether the feature is any good. A
 * reader who double-clicks "he" and is told about helium has been failed by
 * the product even though the data was right, so every rule that prevents
 * that is pinned here, end to end, through the real artifact format.
 */

const provider = openWordNetProvider(openFileArtifact(DICTIONARY_FIXTURE_DIR));

const look = (word: string, raw: string = word, joinedAcrossLines = false): DictionaryResult =>
  provider.lookUp({ normalized: word, raw, joinedAcrossLines });

const firstSense = (
  result: DictionaryResult,
): { partOfSpeech: string; definition: string; source: string } | null =>
  result.status === 'found' || result.status === 'partial' ? (result.senses[0] ?? null) : null;

describe('dictionary quality', () => {
  describe('the commonest words are answered usefully', () => {
    it.each([
      ['he', 'pronoun'],
      ['at', 'preposition'],
      ['a', 'determiner'],
      ['the', 'determiner'],
      ['of', 'preposition'],
      ['and', 'conjunction'],
      ['to', 'preposition'],
    ])('%s is answered as a %s', (word, part) => {
      expect(firstSense(look(word))).toMatchObject({ partOfSpeech: part, source: 'application' });
    });

    it('does not answer "he" with a chemical element', () => {
      const result = look('he');

      expect(
        result.status === 'found' || result.status === 'partial'
          ? result.senses.map((sense) => sense.definition).join(' ')
          : '',
      ).not.toMatch(/gas/iu);
    });

    it('answers "best" with the ordinary adjective, not the surname', () => {
      expect(firstSense(look('best'))).toMatchObject({ partOfSpeech: 'adjective' });
    });

    it('keeps a capitalised reading when the word is written with inner capitals', () => {
      const result = look('us', 'US');
      const definitions =
        result.status === 'found' || result.status === 'partial'
          ? result.senses.map((sense) => sense.definition)
          : [];

      expect(definitions).toContainEqual(expect.stringMatching(/country/u));
    });

    it('suppresses the capitalised reading when the word is written in lower case', () => {
      const result = look('us', 'us');
      const definitions =
        result.status === 'found' || result.status === 'partial'
          ? result.senses.map((sense) => sense.definition)
          : [];

      expect(definitions).not.toContainEqual(expect.stringMatching(/country/u));
    });
  });

  describe('inflection shadowing', () => {
    it.each([
      ['running', 'run'],
      ['stopped', 'stop'],
      ['streaming', 'stream'],
    ])('keeps %s primary and discloses %s', (word, base) => {
      expect(look(word)).toMatchObject({
        headword: word,
        resolvedBy: 'exact',
        alsoInflectionOf: [base],
      });
    });
  });

  describe('morphology', () => {
    it.each([
      ['ran', 'run'],
      ['runs', 'run'],
      ['mice', 'mouse'],
      ['geese', 'goose'],
      ['children', 'child'],
      ['happiest', 'happy'],
      ['carried', 'carry'],
    ])('%s is answered by %s', (word, headword) => {
      expect(look(word)).toMatchObject({ headword, resolvedBy: 'morphology' });
    });

    it.each([
      // A possessive loses its apostrophe before it is looked up, so the
      // singular lands on the headword a stage earlier than the plural, which
      // still needs its "-s" removing.
      ["dog's", 'dog', 'typographic'],
      ["dogs'", 'dog', 'morphology'],
    ])('the possessive %s is answered by %s', (word, headword, stage) => {
      expect(look(word)).toMatchObject({ headword, resolvedBy: stage });
    });
  });

  describe('typographic forms', () => {
    it.each([
      ["don't", 'do'],
      ["can't", 'can'],
      ["won't", 'will'],
      ["they'll", 'they'],
      ["we're", 'we'],
      ["i've", 'i'],
      ["i'm", 'i'],
      ["she'd", 'she'],
    ])('%s is answered by %s', (word, headword) => {
      expect(look(word)).toMatchObject({ headword });
    });

    it.each([
      ['e.g', 'e.g.', 'e.g.'],
      ['etc', 'etc.', 'etc.'],
    ])('the abbreviation %s is answered by %s', (normalized, raw, headword) => {
      expect(look(normalized, raw)).toMatchObject({ headword, resolvedBy: 'typographic' });
    });

    it('answers co-operate from its own hyphenated entry', () => {
      expect(look('co-operate')).toMatchObject({ headword: 'co-operate', resolvedBy: 'exact' });
    });
  });

  describe('words rejoined across a line break', () => {
    it('prefers the hyphenated entry when both forms exist', () => {
      expect(look('co-operate', 'co-\noperate', true)).toMatchObject({
        headword: 'co-operate',
        resolvedBy: 'exact',
      });
    });

    it('joins the halves when only the joined form exists', () => {
      expect(look('light-house', 'light-\nhouse', true)).toMatchObject({
        headword: 'lighthouse',
        resolvedBy: 'typographic',
      });
    });

    it('answers an inflected joined form', () => {
      expect(look('light-houses', 'light-\nhouses', true)).toMatchObject({
        headword: 'lighthouse',
        resolvedBy: 'morphology',
      });
    });

    it('misses when neither form exists', () => {
      expect(look('quux-ling', 'quux-\nling', true)).toMatchObject({ status: 'not-found' });
    });
  });

  it('reports a miss rather than guessing', () => {
    expect(look('zzzznotaword')).toMatchObject({ status: 'not-found', queried: 'zzzznotaword' });
  });

  it('answers the same question the same way every time', () => {
    expect(look('ran')).toEqual(look('ran'));
    expect(look('book')).toEqual(look('book'));
  });
});
