import { describe, expect, it } from 'vitest';

import {
  parseAttribution,
  parseOccurrenceRow,
  parseSavedWordRow,
  parseSnapshot,
  parseSource,
} from './rows';
import type { StoredRow } from './rows';

/** Stored data is input: a row that does not validate is skipped, not fixed. */

const attributionJson = JSON.stringify({
  datasetName: 'Open English WordNet',
  release: '2024',
  licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
  modified: true,
  modificationStatement: 'Transformed.',
  credits: ['Princeton University'],
});

const snapshotJson = JSON.stringify({
  senses: [
    {
      partOfSpeech: 'noun',
      definition: 'any of numerous small rodents',
      examples: ['the mice scattered'],
      synonyms: ['rodent'],
      source: 'wordnet',
    },
  ],
  pronunciations: [{ value: 'maʊs', variety: 'US' }],
  alsoInflectionOf: ['mouse'],
});

const itemRow: StoredRow = {
  id: 'item-1',
  normalized_word: 'mice',
  display_word: 'Mice',
  raw_word: 'Mice',
  joined_across_lines: 0,
  headword: 'mouse',
  resolved_by: 'morphology',
  lookup_status: 'found',
  short_definition: 'any of numerous small rodents',
  snapshot_json: snapshotJson,
  created_at: '2026-10-02T10:00:00.000Z',
  occurrence_count: 2,
  provider: 'wordnet',
  dataset_name: 'Open English WordNet',
  dataset_release: '2024',
  transform_version: '1.0.0',
  attribution_json: attributionJson,
};

const occurrenceRow: StoredRow = {
  document_id: 'doc-1',
  document_name: 'Essays.pdf',
  last_known_path: '/books/Essays.pdf',
  page: 12,
  char_start: 10,
  char_end: 14,
  page_offset_fraction: 0.42,
  context: 'the mice scattered',
  context_word_start: 4,
  created_at: '2026-10-02T10:00:00.000Z',
};

describe('reading an item row', () => {
  it('reads a complete row', () => {
    const item = parseSavedWordRow(itemRow, []);

    expect(item?.word).toEqual({
      raw: 'Mice',
      display: 'Mice',
      normalized: 'mice',
      joinedAcrossLines: false,
    });
    expect(item?.headword).toBe('mouse');
    expect(item?.lookupStatus).toBe('found');
    expect(item?.snapshot?.senses).toHaveLength(1);
    expect(item?.source?.transformVersion).toBe('1.0.0');
    expect(item?.occurrenceCount).toBe(2);
  });

  it('reads a word the dictionary had no entry for', () => {
    const item = parseSavedWordRow(
      {
        ...itemRow,
        headword: null,
        resolved_by: null,
        lookup_status: 'not-found',
        short_definition: null,
        snapshot_json: null,
        provider: null,
      },
      [],
    );

    expect(item?.lookupStatus).toBe('not-found');
    expect(item?.snapshot).toBeNull();
    expect(item?.source).toBeNull();
  });

  it('rejects a row with no identity', () => {
    expect(parseSavedWordRow({ ...itemRow, normalized_word: '' }, [])).toBeNull();
    expect(parseSavedWordRow({ ...itemRow, id: null }, [])).toBeNull();
    expect(parseSavedWordRow({ ...itemRow, created_at: 42 }, [])).toBeNull();
  });

  it('rejects a lookup status it does not know, including unavailable', () => {
    expect(parseSavedWordRow({ ...itemRow, lookup_status: 'unavailable' }, [])).toBeNull();
    expect(parseSavedWordRow({ ...itemRow, lookup_status: 'pending' }, [])).toBeNull();
  });

  it('rejects a resolution it does not know rather than silently dropping it', () => {
    expect(parseSavedWordRow({ ...itemRow, resolved_by: 'guesswork' }, [])).toBeNull();
  });

  it('keeps the item when only the snapshot is damaged', () => {
    const item = parseSavedWordRow({ ...itemRow, snapshot_json: '{not json' }, []);

    expect(item?.word.normalized).toBe('mice');
    expect(item?.snapshot).toBeNull();
  });

  it('accepts a bigint count from a driver that returns one', () => {
    expect(parseSavedWordRow({ ...itemRow, occurrence_count: 7n }, [])?.occurrenceCount).toBe(7);
  });
});

describe('reading an occurrence row', () => {
  it('reads a complete row', () => {
    expect(parseOccurrenceRow(occurrenceRow)).toEqual({
      documentId: 'doc-1',
      documentName: 'Essays.pdf',
      documentPath: '/books/Essays.pdf',
      page: 12,
      charStart: 10,
      charEnd: 14,
      pageOffsetFraction: 0.42,
      context: 'the mice scattered',
      contextWordStart: 4,
      savedAt: '2026-10-02T10:00:00.000Z',
    });
  });

  it('reads an occurrence saved without an anchor', () => {
    const occurrence = parseOccurrenceRow({
      ...occurrenceRow,
      char_start: null,
      char_end: null,
      page_offset_fraction: null,
      context: null,
      context_word_start: null,
      last_known_path: null,
    });

    expect(occurrence?.charStart).toBeNull();
    expect(occurrence?.context).toBeNull();
    expect(occurrence?.documentPath).toBeNull();
  });

  it('rejects a half anchor', () => {
    expect(parseOccurrenceRow({ ...occurrenceRow, char_end: null })).toBeNull();
    expect(parseOccurrenceRow({ ...occurrenceRow, char_start: null })).toBeNull();
  });

  it('rejects an anchor that ends before it starts', () => {
    expect(parseOccurrenceRow({ ...occurrenceRow, char_start: 14, char_end: 10 })).toBeNull();
    expect(parseOccurrenceRow({ ...occurrenceRow, char_start: 10, char_end: 10 })).toBeNull();
    expect(parseOccurrenceRow({ ...occurrenceRow, char_start: -1, char_end: 4 })).toBeNull();
  });

  it('rejects page 0 and pages that are not whole numbers', () => {
    expect(parseOccurrenceRow({ ...occurrenceRow, page: 0 })).toBeNull();
    expect(parseOccurrenceRow({ ...occurrenceRow, page: -2 })).toBeNull();
    expect(parseOccurrenceRow({ ...occurrenceRow, page: 1.5 })).toBeNull();
  });

  it('accepts a 240-character excerpt and rejects a 241-character one', () => {
    expect(parseOccurrenceRow({ ...occurrenceRow, context: 'x'.repeat(240) })).not.toBeNull();
    expect(parseOccurrenceRow({ ...occurrenceRow, context: 'x'.repeat(241) })).toBeNull();
  });
});

describe('reading stored JSON', () => {
  it('rejects a snapshot whose senses are malformed', () => {
    expect(parseSnapshot(JSON.stringify({ senses: [{}], pronunciations: [] }))).toBeNull();
    expect(
      parseSnapshot(
        JSON.stringify({
          senses: [
            {
              partOfSpeech: 'sorcery',
              definition: 'd',
              examples: [],
              synonyms: [],
              source: 'wordnet',
            },
          ],
          pronunciations: [],
        }),
      ),
    ).toBeNull();
  });

  it('rejects a snapshot that is not an object', () => {
    expect(parseSnapshot('[]')).toBeNull();
    expect(parseSnapshot('null')).toBeNull();
    expect(parseSnapshot('')).toBeNull();
    expect(parseSnapshot(7)).toBeNull();
  });

  it('reads attribution and rejects an incomplete one', () => {
    expect(parseAttribution(attributionJson)?.datasetName).toBe('Open English WordNet');
    expect(parseAttribution(JSON.stringify({ datasetName: 'x' }))).toBeNull();
  });

  it('rejects a source row missing its provenance', () => {
    expect(parseSource({ ...itemRow, dataset_release: null })).toBeNull();
    expect(parseSource({ ...itemRow, attribution_json: 'nonsense' })).toBeNull();
  });
});
