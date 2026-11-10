import { describe, expect, it } from 'vitest';

import { locateSavedWord } from './locate';

/** Three outcomes, and no fourth that quietly highlights the wrong text. */

const page =
  'The lighthouse keeper watched the mice cross the floor. Later the mice returned, ' +
  'and the keeper wrote about Mice in his log.';

describe('locating a saved word again', () => {
  it('uses the saved range when it still holds the word', () => {
    const start = page.indexOf('mice');

    expect(locateSavedWord(page, 'mice', start, start + 4)).toEqual({
      kind: 'exact',
      start,
      end: start + 4,
    });
  });

  it('accepts a range that holds the word in another case', () => {
    const start = page.indexOf('Mice');

    expect(locateSavedWord(page, 'mice', start, start + 4)).toMatchObject({ kind: 'exact' });
  });

  it('falls back to the first match when the text has shifted', () => {
    const shifted = `Inserted sentence. ${page}`;
    const original = page.indexOf('mice');

    expect(locateSavedWord(shifted, 'mice', original, original + 4)).toEqual({
      kind: 'approximate',
      start: shifted.indexOf('mice'),
      end: shifted.indexOf('mice') + 4,
    });
  });

  it('falls back when there was never an anchor', () => {
    expect(locateSavedWord(page, 'keeper', null, null)).toEqual({
      kind: 'approximate',
      start: page.indexOf('keeper'),
      end: page.indexOf('keeper') + 6,
    });
  });

  it('says so when the word is not on the page any more', () => {
    expect(locateSavedWord(page, 'albatross', 10, 19)).toEqual({ kind: 'not-found' });
  });

  it('says so when the page has no text layer at all', () => {
    expect(locateSavedWord('', 'mice', 10, 14)).toEqual({ kind: 'not-found' });
  });

  it('never matches a word inside a longer one', () => {
    const text = 'the dormice and the micelle';

    expect(locateSavedWord(text, 'mice', null, null)).toEqual({ kind: 'not-found' });
  });

  it('matches through the same normalisation the save used', () => {
    const text = 'the dog\u2019s bowl';

    expect(locateSavedWord(text, "dog's", null, null)).toMatchObject({ kind: 'approximate' });
  });

  it('ignores an anchor that runs past the end of the page', () => {
    expect(locateSavedWord(page, 'mice', page.length - 2, page.length + 40)).toMatchObject({
      kind: 'approximate',
    });
  });

  it('ignores an anchor that points at different words now', () => {
    const start = page.indexOf('keeper');

    expect(locateSavedWord(page, 'mice', start, start + 4)).toMatchObject({
      kind: 'approximate',
      start: page.indexOf('mice'),
    });
  });
});
