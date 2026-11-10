import { describe, expect, it } from 'vitest';

import { isCapitalisedSense, selectSenses } from './senseSelection';
import type { StoredEntry, StoredSense } from './types';

const sense = (writtenForm: string, definition: string): StoredSense => ({
  partOfSpeech: 'noun',
  definition,
  examples: [],
  synonyms: [],
  writtenForm,
});

const entry = (key: string, senses: readonly StoredSense[]): StoredEntry => ({
  key,
  senses,
  pronunciations: [],
});

describe('case suppression', () => {
  it('recognises a capitalised source spelling', () => {
    expect(isCapitalisedSense(sense('He', 'a gas'))).toBe(true);
    expect(isCapitalisedSense(sense('he', 'a pronoun'))).toBe(false);
  });

  it('drops a capitalised-only sense when the curated layer answers the word', () => {
    const selection = selectSenses(entry('he', [sense('He', 'a light gas')]), 'he', true);

    expect(selection.senses).toEqual([]);
    expect(selection.suppressed).toBe(1);
  });

  it('keeps the ordinary senses and drops the capitalised one', () => {
    const selection = selectSenses(
      entry('best', [sense('best', 'of the highest quality'), sense('Best', 'a scientist')]),
      'best',
      false,
    );

    expect(selection.senses.map((item) => item.definition)).toEqual(['of the highest quality']);
    expect(selection.suppressed).toBe(1);
  });

  it('suppresses regardless of a leading capital, which may only be a sentence start', () => {
    const selection = selectSenses(
      entry('best', [sense('best', 'of the highest quality'), sense('Best', 'a scientist')]),
      'Best',
      false,
    );

    expect(selection.senses).toHaveLength(1);
  });

  it('keeps everything when the word is written with an internal capital', () => {
    const selection = selectSenses(entry('us', [sense('US', 'a country')]), 'US', true);

    expect(selection.senses).toHaveLength(1);
    expect(selection.suppressed).toBe(0);
  });

  it('keeps a genuine proper noun that has no ordinary sense', () => {
    const selection = selectSenses(
      entry('london', [sense('London', 'a capital city')]),
      'London',
      false,
    );

    expect(selection.senses).toHaveLength(1);
  });

  it('leaves an ordinary entry untouched', () => {
    const selection = selectSenses(entry('book', [sense('book', 'bound pages')]), 'book', false);

    expect(selection.senses).toHaveLength(1);
    expect(selection.suppressed).toBe(0);
  });
});
