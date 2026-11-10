import { describe, expect, it } from 'vitest';

import { parseDictionaryQuery, parseDictionaryResult } from './contracts';

/**
 * The dictionary's half of the IPC contract.
 *
 * Both directions are parsed rather than trusted: the renderer must not be
 * able to widen what it asks for, and the renderer must not render a
 * definition that did not survive validation.
 */

const attribution = {
  datasetName: 'Open English WordNet',
  release: '2024',
  licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
  modified: true,
  modificationStatement: 'Modified: filtered and reformatted.',
  credits: ['Princeton University'],
};

const sense = {
  partOfSpeech: 'noun',
  definition: 'A set of printed pages bound together.',
  examples: ['she opened the book'],
  synonyms: ['volume'],
  source: 'wordnet',
};

const found = {
  status: 'found',
  queried: 'books',
  headword: 'book',
  resolvedBy: 'morphology',
  senses: [sense],
  pronunciations: [{ value: 'bʊk', variety: 'GB' }],
  alsoInflectionOf: [],
  attribution,
};

describe('parseDictionaryQuery', () => {
  it('accepts a well-formed query', () => {
    expect(
      parseDictionaryQuery({ normalized: 'book', raw: 'Book', joinedAcrossLines: true }),
    ).toEqual({ normalized: 'book', raw: 'Book', joinedAcrossLines: true });
  });

  it('accepts an empty raw form, because a raw form may legitimately be blank', () => {
    expect(parseDictionaryQuery({ normalized: 'book', raw: '', joinedAcrossLines: false })).toEqual(
      {
        normalized: 'book',
        raw: '',
        joinedAcrossLines: false,
      },
    );
  });

  it('drops anything the renderer adds to the shape', () => {
    const query = parseDictionaryQuery({
      normalized: 'book',
      raw: 'book',
      joinedAcrossLines: false,
      artifactDirectory: '/etc',
      provider: 'remote',
    });

    expect(query).toEqual({ normalized: 'book', raw: 'book', joinedAcrossLines: false });
    expect(query).not.toHaveProperty('artifactDirectory');
    expect(query).not.toHaveProperty('provider');
  });

  it.each([
    ['null', null],
    ['a string', 'book'],
    ['an array', []],
    ['an empty object', {}],
    ['an empty normalised form', { normalized: '', raw: 'book', joinedAcrossLines: false }],
    ['a missing raw form', { normalized: 'book', joinedAcrossLines: false }],
    ['a numeric flag', { normalized: 'book', raw: 'book', joinedAcrossLines: 0 }],
    [
      'a word longer than any real word',
      { normalized: 'x'.repeat(200), raw: 'x', joinedAcrossLines: false },
    ],
  ])('rejects %s', (_label, value) => {
    expect(parseDictionaryQuery(value)).toBeNull();
  });
});

describe('parseDictionaryResult', () => {
  it('accepts a found result', () => {
    expect(parseDictionaryResult(found)).toEqual(found);
  });

  it('accepts a partial result and keeps only the fields it knows', () => {
    const partial = parseDictionaryResult({
      ...found,
      status: 'partial',
      absentFields: ['pronunciation', 'examples', 'nonsense'],
    });

    expect(partial).toMatchObject({
      status: 'partial',
      absentFields: ['pronunciation', 'examples'],
    });
  });

  it('accepts a not-found result with its attempted candidates', () => {
    expect(
      parseDictionaryResult({ status: 'not-found', queried: 'zzz', attempted: ['zzz'] }),
    ).toEqual({ status: 'not-found', queried: 'zzz', attempted: ['zzz'] });
  });

  it.each(['not-installed', 'unreadable', 'corrupt'])('accepts the %s reason', (reason) => {
    expect(parseDictionaryResult({ status: 'unavailable', reason })).toEqual({
      status: 'unavailable',
      reason,
    });
  });

  it('rejects an unavailable reason that is not one of the three', () => {
    expect(parseDictionaryResult({ status: 'unavailable', reason: 'offline' })).toBeNull();
    expect(parseDictionaryResult({ status: 'unavailable', reason: '/home/user/x' })).toBeNull();
  });

  it('defaults a pronunciation of unknown variety rather than inventing one', () => {
    const result = parseDictionaryResult({
      ...found,
      pronunciations: [{ value: 'bʊk', variety: 'Martian' }, { value: '' }, 'nonsense'],
    });

    expect(result).toMatchObject({ pronunciations: [{ value: 'bʊk', variety: 'unspecified' }] });
  });

  it.each([
    ['an unknown status', { ...found, status: 'maybe' }],
    ['no senses', { ...found, senses: [] }],
    ['a sense with no definition', { ...found, senses: [{ ...sense, definition: '' }] }],
    [
      'a sense with an unknown part of speech',
      { ...found, senses: [{ ...sense, partOfSpeech: 'interjection' }] },
    ],
    ['a sense from an unknown source', { ...found, senses: [{ ...sense, source: 'guess' }] }],
    ['an unknown resolution stage', { ...found, resolvedBy: 'guessing' }],
    ['no attribution', { ...found, attribution: undefined }],
    [
      'an attribution with no licence url',
      { ...found, attribution: { ...attribution, licences: [{ name: 'x' }] } },
    ],
    ['a not-found result with no word', { status: 'not-found', queried: '' }],
  ])('rejects %s', (_label, value) => {
    expect(parseDictionaryResult(value)).toBeNull();
  });

  it('is stable: parsing its own output changes nothing', () => {
    const once = parseDictionaryResult(found);

    expect(parseDictionaryResult(once)).toEqual(once);
  });
});
