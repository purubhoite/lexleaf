import { describe, expect, it } from 'vitest';

import type { DictionaryResult } from '../dictionary/types';

import { snapshotFrom, sourceFrom, UNKNOWN_TRANSFORM_VERSION } from './snapshot';

/** A snapshot is what the reader was shown, and nothing else. */

const attribution = {
  datasetName: 'Open English WordNet',
  release: '2024',
  licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
  modified: true,
  modificationStatement: 'Transformed into an indexed lookup artifact.',
  credits: ['Princeton University'],
};

const answer: DictionaryResult = {
  status: 'found',
  queried: 'mice',
  headword: 'mouse',
  resolvedBy: 'morphology',
  senses: [
    {
      partOfSpeech: 'noun',
      definition: 'any of numerous small rodents',
      examples: ['the mice scattered'],
      synonyms: ['rodent'],
      source: 'wordnet',
    },
    {
      partOfSpeech: 'noun',
      definition: 'a hand-operated electronic device',
      examples: [],
      synonyms: [],
      source: 'wordnet',
    },
  ],
  pronunciations: [{ value: 'maʊs', variety: 'US' }],
  alsoInflectionOf: ['mouse'],
  attribution,
};

const partial: DictionaryResult = {
  status: 'partial',
  queried: 'thole',
  headword: 'thole',
  resolvedBy: 'exact',
  senses: [
    {
      partOfSpeech: 'noun',
      definition: 'a pin in a gunwale',
      examples: [],
      synonyms: [],
      source: 'wordnet',
    },
  ],
  pronunciations: [],
  alsoInflectionOf: [],
  attribution,
  absentFields: ['pronunciation'],
};

const notFound: DictionaryResult = { status: 'not-found', queried: 'xyzzy', attempted: ['xyzzy'] };

const unavailable: DictionaryResult = { status: 'unavailable', reason: 'corrupt' };

describe('the dictionary snapshot', () => {
  it('preserves every sense the popup rendered, in order', () => {
    const snapshot = snapshotFrom(answer);

    expect(snapshot?.senses.map((sense) => sense.definition)).toEqual([
      'any of numerous small rodents',
      'a hand-operated electronic device',
    ]);
    expect(snapshot?.senses[0]?.examples).toEqual(['the mice scattered']);
    expect(snapshot?.senses[0]?.synonyms).toEqual(['rodent']);
    expect(snapshot?.senses[0]?.source).toBe('wordnet');
  });

  it('preserves pronunciations and inflection notes as shown', () => {
    const snapshot = snapshotFrom(answer);

    expect(snapshot?.pronunciations).toEqual([{ value: 'maʊs', variety: 'US' }]);
    expect(snapshot?.alsoInflectionOf).toEqual(['mouse']);
  });

  it('stores nothing that describes where the dictionary lives', () => {
    const serialised = JSON.stringify(snapshotFrom(answer));

    for (const forbidden of ['path', 'offset', 'entries.jsonl', 'index', 'byte']) {
      expect(serialised.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('keeps a partial answer, because that is what was shown', () => {
    expect(snapshotFrom(partial)?.senses).toHaveLength(1);
    expect(snapshotFrom(partial)?.pronunciations).toEqual([]);
  });

  it('has no snapshot when there was no entry', () => {
    expect(snapshotFrom(notFound)).toBeNull();
    expect(sourceFrom(notFound, '1.0.0')).toBeNull();
  });

  it('has no snapshot when the dictionary could not answer', () => {
    expect(snapshotFrom(unavailable)).toBeNull();
    expect(sourceFrom(unavailable, '1.0.0')).toBeNull();
  });

  it('is a copy: later mutation of the result cannot reach it', () => {
    const examples = ['original'];
    const mutable: DictionaryResult = {
      ...answer,
      status: 'found',
      senses: [
        { partOfSpeech: 'noun', definition: 'a rodent', examples, synonyms: [], source: 'wordnet' },
      ],
    };
    const snapshot = snapshotFrom(mutable);

    examples[0] = 'changed';

    expect(snapshot?.senses[0]?.examples).toEqual(['original']);
  });
});

describe('the dictionary source', () => {
  it('records provider, dataset, release, transform version and attribution', () => {
    expect(sourceFrom(answer, '1.0.0')).toEqual({
      provider: 'wordnet',
      datasetName: 'Open English WordNet',
      datasetRelease: '2024',
      transformVersion: '1.0.0',
      attribution,
    });
  });

  it('says so honestly when the artifact version cannot be read', () => {
    expect(sourceFrom(answer, '')?.transformVersion).toBe(UNKNOWN_TRANSFORM_VERSION);
  });
});
