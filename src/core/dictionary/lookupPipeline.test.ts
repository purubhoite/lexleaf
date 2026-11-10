import { describe, expect, it } from 'vitest';

import { lookUpWord, type LookupContext } from './lookupPipeline';
import { morphologyTablesFrom } from './morphology';
import type {
  DictionaryAttribution,
  DictionaryQuery,
  DictionaryResult,
  DictionaryStore,
  StoredEntry,
  StoredSense,
} from './types';

/**
 * The pipeline is tested over an in-memory store.
 *
 * The real artifact is not involved and is never downloaded: what is under
 * test here is the order of the fallback stages and the content rules, both
 * of which are pure functions of the store's contents.
 */

const attribution: DictionaryAttribution = {
  datasetName: 'Test dictionary',
  release: 'fixture',
  licences: [{ name: 'Test licence', url: 'file://test' }],
  modified: true,
  modificationStatement: 'Modified: synthetic test data.',
  credits: ['Written for the test suite.'],
};

interface SenseInput {
  readonly part?: StoredSense['partOfSpeech'];
  readonly definition: string;
  readonly written?: string;
  readonly examples?: readonly string[];
  readonly synonyms?: readonly string[];
}

const build = (
  definitions: Readonly<Record<string, readonly SenseInput[]>>,
  pronunciations: Readonly<Record<string, string>> = {},
): DictionaryStore => {
  const entries = new Map<string, StoredEntry>();

  for (const [key, senses] of Object.entries(definitions)) {
    entries.set(key, {
      key,
      senses: senses.map((sense) => ({
        partOfSpeech: sense.part ?? 'noun',
        definition: sense.definition,
        examples: sense.examples ?? [],
        synonyms: sense.synonyms ?? [],
        writtenForm: sense.written ?? key,
      })),
      pronunciations:
        pronunciations[key] === undefined
          ? []
          : [{ value: pronunciations[key], variety: 'unspecified' }],
    });
  }

  return { get: (key: string): StoredEntry | null => entries.get(key) ?? null };
};

const store = build(
  {
    a: [{ definition: 'a unit of length', written: 'A' }],
    at: [{ definition: 'a chemical element', written: 'At' }],
    best: [
      { part: 'adjective', definition: 'of the highest quality' },
      { definition: 'a scientist', written: 'Best' },
    ],
    book: [
      { definition: 'bound pages', examples: ['she read the book'], synonyms: ['volume'] },
      { part: 'verb', definition: 'to reserve' },
    ],
    'co-operate': [{ part: 'verb', definition: 'to work together, hyphenated' }],
    cooperate: [{ part: 'verb', definition: 'to work together' }],
    do: [{ part: 'verb', definition: 'to carry out an action' }],
    'e.g.': [{ part: 'adverb', definition: 'for example' }],
    good: [{ part: 'adjective', definition: 'of acceptable quality' }],
    he: [{ definition: 'a light gas', written: 'He' }],
    lighthouse: [{ definition: 'a tower with a warning light' }],
    london: [{ definition: 'a capital city', written: 'London' }],
    mouse: [{ definition: 'a small rodent' }],
    run: [{ part: 'verb', definition: 'to move quickly on foot' }],
    running: [{ definition: 'the sport of moving at speed on foot' }],
    stop: [{ part: 'verb', definition: 'to bring to an end' }],
    stopped: [{ part: 'adjective', definition: 'blocked' }],
    stream: [{ part: 'verb', definition: 'to flow steadily' }],
    streaming: [{ definition: 'delivery that plays while it arrives' }],
    will: [{ definition: 'a legal document' }],
  },
  { book: 'bʊk' },
);

const context: LookupContext = {
  store,
  tables: morphologyTablesFrom({
    noun: { mice: ['mouse'] },
    verb: { ran: ['run'] },
    adjective: { best: ['good'] },
    adverb: {},
  }),
  attribution,
};

const query = (
  normalized: string,
  raw: string = normalized,
  joinedAcrossLines = false,
): DictionaryQuery => ({ normalized, raw, joinedAcrossLines });

const look = (normalized: string, raw?: string, joinedAcrossLines?: boolean): DictionaryResult =>
  lookUpWord(query(normalized, raw, joinedAcrossLines), context);

const definitions = (result: DictionaryResult): readonly string[] =>
  result.status === 'found' || result.status === 'partial'
    ? result.senses.map((sense) => sense.definition)
    : [];

describe('lookup pipeline', () => {
  it('answers an exact match', () => {
    const result = look('book');

    expect(result.status).toBe('found');
    expect(result).toMatchObject({ headword: 'book', resolvedBy: 'exact' });
    expect(definitions(result)[0]).toBe('bound pages');
  });

  it('marks a result partial when the source has no pronunciation', () => {
    const result = look('mouse');

    expect(result.status).toBe('partial');
    expect(result).toMatchObject({ absentFields: ['pronunciation', 'examples', 'synonyms'] });
  });

  it('stamps the attribution on every answer', () => {
    expect(look('book')).toMatchObject({ attribution });
  });

  describe('content quality', () => {
    it.each([
      ['he', 'pronoun'],
      ['at', 'preposition'],
      ['a', 'determiner'],
      ['the', 'determiner'],
      ['of', 'preposition'],
      ['and', 'conjunction'],
      ['to', 'preposition'],
    ])('answers %s with its grammatical sense first', (word, part) => {
      const result = look(word);

      expect(result.status).not.toBe('not-found');
      expect(
        result.status === 'found' || result.status === 'partial'
          ? result.senses.map((sense) => sense.partOfSpeech)
          : [],
      ).toContain(part);
      expect(
        (result.status === 'found' || result.status === 'partial') && result.senses[0]?.source,
      ).toBe('application');
    });

    it('does not tell a reader that "he" is a gas', () => {
      expect(definitions(look('he')).join(' ')).not.toContain('gas');
    });

    it('answers "best" with the ordinary sense, not the surname', () => {
      const result = look('best');

      expect(definitions(result)).toEqual(['of the highest quality']);
      expect(result).toMatchObject({ alsoInflectionOf: ['good'] });
    });

    it.each([
      ['running', 'run'],
      ['stopped', 'stop'],
      ['streaming', 'stream'],
    ])('keeps the entry for %s primary and discloses the base form %s', (word, base) => {
      const result = look(word);

      expect(result).toMatchObject({
        headword: word,
        resolvedBy: 'exact',
        alsoInflectionOf: [base],
      });
    });

    it('does not invent an inflection for a short word', () => {
      expect(look('will')).toMatchObject({ alsoInflectionOf: [] });
    });

    it('shows a proper noun when the spelling has no ordinary sense', () => {
      expect(definitions(look('london', 'London'))).toEqual(['a capital city']);
    });

    it('shows the verb first for a past-tense form, not the noun', () => {
      // "booked" can only have been found by a verb rule, so answering with
      // "bound pages" first would be true of the headword and wrong about
      // the word on the page.
      const result = look('booked');

      expect(result).toMatchObject({ headword: 'book', resolvedBy: 'morphology' });
      expect(definitions(result)[0]).toBe('to reserve');
    });

    it('shows the verb first for an -ing form', () => {
      expect(definitions(look('booking'))[0]).toBe('to reserve');
    });

    it('leaves the published order alone when the rules assume both parts', () => {
      // "books" is a plural noun rule and a present-tense verb rule at once;
      // with nothing to choose between them the source order stands.
      expect(definitions(look('books'))).toEqual(['bound pages', 'to reserve']);
    });

    it('keeps every sense reachable when it reorders', () => {
      expect(definitions(look('booked'))).toHaveLength(2);
    });

    it('leaves the order alone when the entry has no sense of the assumed part', () => {
      // "mice" is a noun rule and "mouse" is a noun: nothing to reorder.
      expect(definitions(look('mice'))).toEqual(['a small rodent']);
    });
  });

  describe('fallback stages', () => {
    it('falls back to a morphological base form', () => {
      expect(look('ran')).toMatchObject({
        headword: 'run',
        resolvedBy: 'morphology',
        queried: 'ran',
      });
    });

    it('resolves a contraction to its host word', () => {
      expect(look("don't")).toMatchObject({ headword: 'do', resolvedBy: 'typographic' });
    });

    it('resolves a dotted abbreviation using the raw text', () => {
      expect(look('e.g', 'e.g.')).toMatchObject({ headword: 'e.g.', resolvedBy: 'typographic' });
    });

    it('prefers the hyphenated form when both exist', () => {
      expect(look('co-operate')).toMatchObject({
        headword: 'co-operate',
        resolvedBy: 'exact',
      });
    });

    it.each([
      ['light-house', 'light-\nhouse', 'lighthouse', 'typographic'],
      ['co-operate', 'co-\noperate', 'co-operate', 'exact'],
    ])('resolves the line break in %s', (normalized, raw, headword, resolvedBy) => {
      expect(look(normalized, raw, true)).toMatchObject({ headword, resolvedBy });
    });

    it('misses when neither side of a line break exists', () => {
      expect(look('quux-ling', 'quux-\nling', true)).toMatchObject({ status: 'not-found' });
    });

    it('reports a miss with the keys it tried', () => {
      const result = look('zzzznotaword');

      expect(result).toMatchObject({ status: 'not-found', queried: 'zzzznotaword' });
      expect(result.status === 'not-found' && result.attempted).toContain('zzzznotaword');
    });
  });

  describe('determinism', () => {
    it('returns the same answer for the same question', () => {
      expect(look('ran')).toEqual(look('ran'));
      expect(look('he')).toEqual(look('he'));
    });

    it('does not depend on the order in which words were asked', () => {
      const first = [look('book'), look('ran'), look('he')];
      const second = [look('he'), look('ran'), look('book')];

      expect(first[0]).toEqual(second[2]);
      expect(first[2]).toEqual(second[0]);
    });
  });

  describe('malformed data', () => {
    it('treats an entry the store rejects as absent rather than guessing', () => {
      const result = lookUpWord(query('broken'), {
        ...context,
        store: { get: (): null => null },
      });

      expect(result.status).toBe('not-found');
    });

    it('never fabricates an example, a synonym or a pronunciation', () => {
      const result = look('mouse');

      expect(result).toMatchObject({
        pronunciations: [],
        senses: [expect.objectContaining({ examples: [], synonyms: [] })],
      });
    });
  });

  it('keeps application-authored senses labelled as such', () => {
    const result = look('the');

    expect(result).toMatchObject({
      resolvedBy: 'closed-class',
      senses: [expect.objectContaining({ source: 'application' })],
    });
  });

  it('puts the grammatical sense before the dictionary senses of the same word', () => {
    const result = look('will');

    expect(result.status === 'found' || result.status === 'partial').toBe(true);
    expect(result).toMatchObject({
      senses: [
        expect.objectContaining({ source: 'application', partOfSpeech: 'auxiliary verb' }),
        expect.objectContaining({ source: 'wordnet', definition: 'a legal document' }),
      ],
    });
  });
});
