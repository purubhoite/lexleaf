import { describe, expect, it } from 'vitest';

import { contractionHost, lookupCandidates } from './candidates';
import { morphologyTablesFrom } from './morphology';
import type { DictionaryQuery } from './types';

const tables = morphologyTablesFrom({
  noun: { mice: ['mouse'] },
  verb: { ran: ['run'] },
  adjective: {},
  adverb: {},
});

const query = (
  normalized: string,
  raw: string = normalized,
  joinedAcrossLines = false,
): DictionaryQuery => ({ normalized, raw, joinedAcrossLines });

const keys = (value: DictionaryQuery): readonly string[] =>
  lookupCandidates(value, tables).map((candidate) => candidate.key);

describe('lookup candidates', () => {
  it('tries the normalised form first', () => {
    expect(keys(query('book'))[0]).toBe('book');
  });

  it('marks the stage each key belongs to', () => {
    const candidates = lookupCandidates(query('ran'), tables);

    expect(candidates[0]).toEqual({
      key: 'ran',
      stage: 'exact',
      via: 'normalized',
      assumedParts: [],
    });
    expect(candidates).toContainEqual({
      key: 'run',
      stage: 'morphology',
      via: 'base-form',
      assumedParts: ['verb'],
    });
  });

  it('restores the period of a dotted abbreviation', () => {
    const candidates = lookupCandidates(query('e.g', 'e.g.'), tables);

    expect(candidates).toContainEqual({
      key: 'e.g.',
      stage: 'typographic',
      via: 'restored-period',
      assumedParts: [],
    });
    expect(candidates).toContainEqual({
      key: 'eg',
      stage: 'typographic',
      via: 'dots-removed',
      assumedParts: [],
    });
  });

  it.each([
    ["don't", 'do'],
    ["can't", 'can'],
    ["won't", 'will'],
    ["they'll", 'they'],
    ["we're", 'we'],
    ["i've", 'i'],
    ["i'm", 'i'],
    ["she'd", 'she'],
  ])('resolves the contraction %s to its host %s', (contraction, host) => {
    expect(contractionHost(contraction)).toBe(host);
    expect(keys(query(contraction))).toContain(host);
  });

  it('keeps the hyphenated form ahead of the joined one', () => {
    const candidates = keys(query('light-house', 'light-\nhouse', true));

    expect(candidates.indexOf('light-house')).toBeLessThan(candidates.indexOf('lighthouse'));
  });

  it('offers the spaced form of a hyphenated word', () => {
    expect(keys(query('co-operate'))).toEqual(
      expect.arrayContaining(['co-operate', 'cooperate', 'co operate']),
    );
  });

  it('looks for inflections of a word rejoined across a line break', () => {
    expect(keys(query('light-houses', 'light-\nhouses', true))).toContain('lighthouse');
  });

  it('uses the raw text to recover a case-folded key', () => {
    const candidates = lookupCandidates(query('fish', 'ﬁsh'), tables);

    expect(candidates).toContainEqual({
      key: 'ﬁsh',
      stage: 'case',
      via: 'case-folded-raw',
      assumedParts: [],
    });
  });

  it('never proposes an empty key', () => {
    expect(keys(query('', '—'))).toEqual([]);
  });

  it('is deterministic', () => {
    expect(keys(query('mice'))).toEqual(keys(query('mice')));
  });

  it('bounds how much work one lookup can cause', () => {
    expect(keys(query("a-b-c-d-e-f's")).length).toBeLessThanOrEqual(32);
  });
});
