import type { DictionaryResult } from '@core/dictionary/types';
import { describe, expect, it } from 'vitest';

import {
  MAXIMUM_SAVED_WORD_LENGTH,
  parseItemId,
  parseLibraryQuery,
  parseLibraryPageResult,
  parseSavedWordResult,
  parseSaveWordRequest,
  parseSearchQuery,
  parseStateForWordRequest,
  parseStateResult,
} from './vocabularyContracts';

/** Both directions are parsed, because neither side is trusted. */

const result: DictionaryResult = {
  status: 'found',
  queried: 'mice',
  headword: 'mouse',
  resolvedBy: 'morphology',
  senses: [
    {
      partOfSpeech: 'noun',
      definition: 'small rodents',
      examples: [],
      synonyms: [],
      source: 'wordnet',
    },
  ],
  pronunciations: [],
  alsoInflectionOf: [],
  attribution: {
    datasetName: 'Open English WordNet',
    release: '2024',
    licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
    modified: true,
    modificationStatement: 'Transformed.',
    credits: ['Princeton University'],
  },
};

const saveRequest = {
  word: { raw: 'Mice', display: 'Mice', normalized: 'mice', joinedAcrossLines: false },
  documentId: 'doc-1',
  pageCount: 300,
  occurrence: {
    page: 12,
    charStart: 10,
    charEnd: 14,
    pageOffsetFraction: 0.4,
    context: 'the mice scattered',
    contextWordStart: 4,
  },
  result,
};

describe('the state request', () => {
  it('accepts a word, a document and a page, and nothing else', () => {
    expect(parseStateForWordRequest({ normalized: 'mice', documentId: 'doc-1', page: 3 })).toEqual({
      normalized: 'mice',
      documentId: 'doc-1',
      page: 3,
    });
  });

  it('carries no character range to be confused with identity', () => {
    const parsed = parseStateForWordRequest({
      normalized: 'mice',
      documentId: 'doc-1',
      page: 3,
      charStart: 10,
      charEnd: 14,
    });

    expect(parsed).not.toHaveProperty('charStart');
    expect(Object.keys(parsed ?? {})).toEqual(['normalized', 'documentId', 'page']);
  });

  it('rejects page 0, a missing document and an oversized word', () => {
    expect(
      parseStateForWordRequest({ normalized: 'mice', documentId: 'doc-1', page: 0 }),
    ).toBeNull();
    expect(parseStateForWordRequest({ normalized: 'mice', documentId: '', page: 1 })).toBeNull();
    expect(
      parseStateForWordRequest({
        normalized: 'x'.repeat(MAXIMUM_SAVED_WORD_LENGTH + 1),
        documentId: 'doc-1',
        page: 1,
      }),
    ).toBeNull();
    expect(parseStateForWordRequest(null)).toBeNull();
  });
});

describe('the save request', () => {
  it('accepts a complete request', () => {
    expect(parseSaveWordRequest(saveRequest)?.word.normalized).toBe('mice');
  });

  it('has nowhere to put a filesystem path', () => {
    const parsed = parseSaveWordRequest({ ...saveRequest, path: '/etc/passwd' });

    expect(parsed).not.toBeNull();
    expect(JSON.stringify(parsed)).not.toContain('/etc/passwd');
  });

  it('rejects a half anchor and an anchor that ends before it starts', () => {
    expect(
      parseSaveWordRequest({
        ...saveRequest,
        occurrence: { ...saveRequest.occurrence, charEnd: null },
      }),
    ).toBeNull();
    expect(
      parseSaveWordRequest({
        ...saveRequest,
        occurrence: { ...saveRequest.occurrence, charStart: 20, charEnd: 14 },
      }),
    ).toBeNull();
  });

  it('rejects an excerpt longer than the stored limit', () => {
    expect(
      parseSaveWordRequest({
        ...saveRequest,
        occurrence: { ...saveRequest.occurrence, context: 'x'.repeat(241) },
      }),
    ).toBeNull();
    expect(
      parseSaveWordRequest({
        ...saveRequest,
        occurrence: { ...saveRequest.occurrence, context: 'x'.repeat(240) },
      }),
    ).not.toBeNull();
  });

  it('rejects page 0 and a page offset outside the page', () => {
    expect(
      parseSaveWordRequest({ ...saveRequest, occurrence: { ...saveRequest.occurrence, page: 0 } }),
    ).toBeNull();
    expect(
      parseSaveWordRequest({
        ...saveRequest,
        occurrence: { ...saveRequest.occurrence, pageOffsetFraction: 1.5 },
      }),
    ).toBeNull();
  });

  it('rejects a malformed dictionary result rather than storing it', () => {
    expect(parseSaveWordRequest({ ...saveRequest, result: { status: 'invented' } })).toBeNull();
  });

  it('accepts a save with no anchor at all', () => {
    expect(
      parseSaveWordRequest({
        ...saveRequest,
        occurrence: {
          page: 2,
          charStart: null,
          charEnd: null,
          pageOffsetFraction: null,
          context: null,
          contextWordStart: null,
        },
      }),
    ).not.toBeNull();
  });
});

describe('ids and queries', () => {
  it('reads an item id from either shape and rejects an oversized one', () => {
    expect(parseItemId({ itemId: 'item-1' })).toBe('item-1');
    expect(parseItemId('item-1')).toBe('item-1');
    expect(parseItemId({ itemId: 'x'.repeat(129) })).toBeNull();
    expect(parseItemId({})).toBeNull();
  });

  it('accepts only the three sort orders', () => {
    expect(
      parseLibraryQuery({ sort: 'newest', documentId: null, cursor: null, limit: 50 })?.sort,
    ).toBe('newest');
    expect(
      parseLibraryQuery({ sort: 'created_at DESC', documentId: null, cursor: null }),
    ).toBeNull();
  });

  it('clamps the page size rather than refusing it', () => {
    expect(
      parseLibraryQuery({ sort: 'newest', documentId: null, cursor: null, limit: 10_000 })?.limit,
    ).toBe(50);
    expect(parseLibraryQuery({ sort: 'newest', documentId: null, cursor: null })?.limit).toBe(50);
  });

  it('accepts a cursor only in the shape it was issued in', () => {
    expect(
      parseLibraryQuery({
        sort: 'newest',
        documentId: null,
        cursor: { sortKey: '2026-01-01', id: 'item-1' },
        limit: 50,
      })?.cursor,
    ).toEqual({ sortKey: '2026-01-01', id: 'item-1' });
    expect(
      parseLibraryQuery({ sort: 'newest', documentId: null, cursor: { sortKey: 5 }, limit: 50 }),
    ).toBeNull();
  });

  it('bounds a search query and caps its limit at two hundred', () => {
    expect(parseSearchQuery({ query: 'mice', documentId: null, limit: 10_000 })?.limit).toBe(200);
    expect(parseSearchQuery({ query: 'x'.repeat(129), documentId: null })).toBeNull();
    expect(parseSearchQuery({ query: '', documentId: null })?.query).toBe('');
  });
});

describe('replies on the way back', () => {
  it('reads a state result', () => {
    expect(parseStateResult({ ok: true, value: { state: 'not-saved' } })).toEqual({
      ok: true,
      value: { state: 'not-saved' },
    });
    expect(
      parseStateResult({
        ok: true,
        value: { state: 'saved-here', itemId: 'item-1', otherPlaces: 2 },
      })?.ok,
    ).toBe(true);
  });

  it('reads a typed failure', () => {
    expect(
      parseStateResult({ ok: false, error: { kind: 'unavailable', reason: 'locked' } }),
    ).toEqual({ ok: false, error: { kind: 'unavailable', reason: 'locked' } });
    expect(parseStateResult({ ok: false, error: { kind: 'write-failed' } })?.ok).toBe(false);
  });

  it('refuses a failure reason it does not know', () => {
    expect(
      parseStateResult({ ok: false, error: { kind: 'unavailable', reason: 'disk' } }),
    ).toBeNull();
    expect(parseStateResult({ ok: false, error: { kind: 'oops' } })).toBeNull();
  });

  it('reads a saved word and refuses a malformed one', () => {
    const item = {
      id: 'item-1',
      word: { raw: 'Mice', display: 'Mice', normalized: 'mice', joinedAcrossLines: false },
      headword: 'mouse',
      resolvedBy: 'morphology',
      lookupStatus: 'found',
      shortDefinition: 'small rodents',
      snapshot: null,
      source: null,
      occurrences: [
        {
          documentId: 'doc-1',
          documentName: 'Essays.pdf',
          documentPath: null,
          page: 12,
          charStart: null,
          charEnd: null,
          pageOffsetFraction: null,
          context: null,
          contextWordStart: null,
          savedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      savedAt: '2026-01-01T00:00:00.000Z',
      occurrenceCount: 1,
    };

    expect(parseSavedWordResult({ ok: true, value: item })?.ok).toBe(true);
    expect(
      parseSavedWordResult({ ok: true, value: { ...item, lookupStatus: 'unavailable' } }),
    ).toBeNull();
    expect(parseSavedWordResult({ ok: true, value: { ...item, occurrences: [{}] } })).toBeNull();
  });

  it('reads a library page with its document filter', () => {
    const page = parseLibraryPageResult({
      ok: true,
      value: {
        items: [],
        documents: [{ documentId: 'doc-1', name: 'Essays.pdf', available: true, count: 3 }],
        nextCursor: null,
        unreadable: 2,
      },
    });

    expect(page?.ok === true && page.value.documents).toHaveLength(1);
    expect(page?.ok === true && page.value.unreadable).toBe(2);
  });

  it('refuses a reply that is not a result at all', () => {
    expect(parseStateResult(undefined)).toBeNull();
    expect(parseStateResult({ ok: 'yes' })).toBeNull();
    expect(parseLibraryPageResult({ ok: true, value: { items: 'all of them' } })).toBeNull();
  });
});
