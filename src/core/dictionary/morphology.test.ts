import { describe, expect, it } from 'vitest';

import { baseFormCandidates, baseForms, morphologyTablesFrom } from './morphology';
import type { MorphologyTables } from './types';

const tables: MorphologyTables = morphologyTablesFrom({
  noun: { children: ['child'], geese: ['goose'], mice: ['mouse'] },
  verb: { carried: ['carry'], ran: ['run'] },
  adjective: { best: ['good'], happiest: ['happy'] },
  adverb: {},
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
    ["dog's", 'dog'],
    ["dogs'", 'dog'],
    ['running', 'run'],
    ['stopped', 'stop'],
    ['streaming', 'stream'],
  ])('proposes %s → %s', (inflected, base) => {
    expect(baseForms(inflected, tables)).toContain(base);
  });

  it('never proposes the word itself', () => {
    expect(baseForms('runs', tables)).not.toContain('runs');
  });

  it('records the part of speech a rule assumes', () => {
    const candidates = baseFormCandidates('running', tables);
    const run = candidates.find((candidate) => candidate.base === 'run');

    expect(run).toEqual({
      base: 'run',
      partOfSpeech: 'verb',
      origin: 'doubled-consonant',
      suffix: 'ing',
    });
  });

  it('marks exception-list results as exceptions', () => {
    const [first] = baseFormCandidates('mice', tables);

    expect(first).toEqual({ base: 'mouse', partOfSpeech: 'noun', origin: 'exception', suffix: '' });
  });

  it('strips a plural possessive in two steps', () => {
    expect(baseForms("mice's", tables)).toEqual(expect.arrayContaining(['mice', 'mouse']));
  });

  it('proposes nothing for a word with no inflectional shape', () => {
    expect(baseForms('of', tables)).toEqual([]);
  });

  it('produces the same answer every time', () => {
    expect(baseForms('carried', tables)).toEqual(baseForms('carried', tables));
  });

  it('drops malformed exception tables rather than repairing them', () => {
    const malformed = morphologyTablesFrom({
      noun: { good: 'not-an-array', fine: ['base'], '': ['x'], empty: [] },
      verb: 'nonsense',
    });

    expect([...malformed.noun.keys()]).toEqual(['fine']);
    expect(malformed.verb.size).toBe(0);
  });
});
