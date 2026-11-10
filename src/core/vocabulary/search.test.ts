import { describe, expect, it } from 'vitest';

import {
  clampLimit,
  cursorFor,
  escapeLikePattern,
  LIBRARY_PAGE_SIZE,
  MAX_SEARCH_RESULTS,
  MIN_DEFINITION_QUERY_LENGTH,
  prepareSearch,
  sortKeyOf,
} from './search';
import type { SavedWord } from './types';

/** Search rules: normalise, escape, two tiers, declared limits. */

const item = (overrides: Partial<SavedWord> = {}): SavedWord => ({
  id: 'item-1',
  word: { raw: 'Mice', display: 'Mice', normalized: 'mice', joinedAcrossLines: false },
  headword: 'mouse',
  resolvedBy: 'morphology',
  lookupStatus: 'found',
  shortDefinition: 'small rodents',
  snapshot: null,
  source: null,
  occurrences: [],
  savedAt: '2026-10-02T10:00:00.000Z',
  occurrenceCount: 1,
  ...overrides,
});

describe('preparing a query', () => {
  it('treats an empty query as a listing, not a search', () => {
    expect(prepareSearch('')).toEqual({ kind: 'listing' });
    expect(prepareSearch('   ')).toEqual({ kind: 'listing' });
    expect(prepareSearch('…')).toEqual({ kind: 'listing' });
  });

  it('normalises the query with the one Unicode-aware normaliser', () => {
    const prepared = prepareSearch('  CAFÉ ');

    expect(prepared.kind === 'search' && prepared.plan.normalized).toBe('café');
    expect(prepared.kind === 'search' && prepared.plan.prefixPattern).toBe('café%');
  });

  it('searches definitions only from three characters', () => {
    const short = prepareSearch('ru');
    const long = prepareSearch('run');

    expect(short.kind === 'search' && short.plan.definitionPattern).toBeNull();
    expect(long.kind === 'search' && long.plan.definitionPattern).toBe('%run%');
    expect(MIN_DEFINITION_QUERY_LENGTH).toBe(3);
  });

  it('escapes LIKE wildcards so a reader cannot match the whole library', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('back\\slash')).toBe('back\\\\slash');

    // The normaliser trims symbols at the edges, so the wildcard that
    // survives into a pattern is an interior one.
    const prepared = prepareSearch('a_b%c');

    expect(prepared.kind === 'search' && prepared.plan.prefixPattern).toBe('a\\_b\\%c%');
  });

  it('keeps the escape visible in both tiers', () => {
    const prepared = prepareSearch('50%x');

    expect(prepared.kind === 'search' && prepared.plan.definitionPattern).toBe('%50\\%x%');
  });
});

describe('declared limits', () => {
  it('caps searches at 200 rows and pages the library at 50', () => {
    expect(MAX_SEARCH_RESULTS).toBe(200);
    expect(LIBRARY_PAGE_SIZE).toBe(50);
  });

  it('clamps anything a renderer asks for', () => {
    expect(clampLimit(10, LIBRARY_PAGE_SIZE)).toBe(10);
    expect(clampLimit(5_000, LIBRARY_PAGE_SIZE)).toBe(LIBRARY_PAGE_SIZE);
    expect(clampLimit(0, LIBRARY_PAGE_SIZE)).toBe(LIBRARY_PAGE_SIZE);
    expect(clampLimit(-3, MAX_SEARCH_RESULTS)).toBe(MAX_SEARCH_RESULTS);
    expect(clampLimit(Number.NaN, MAX_SEARCH_RESULTS)).toBe(MAX_SEARCH_RESULTS);
    expect(clampLimit(12.7, LIBRARY_PAGE_SIZE)).toBe(12);
  });
});

describe('keyset cursors', () => {
  it('pages date-ordered listings on the save date', () => {
    expect(sortKeyOf(item(), 'newest')).toBe('2026-10-02T10:00:00.000Z');
    expect(sortKeyOf(item(), 'oldest')).toBe('2026-10-02T10:00:00.000Z');
  });

  it('pages alphabetical listings on the displayed word, case-folded', () => {
    expect(sortKeyOf(item(), 'alphabetical')).toBe('mice');
  });

  it('carries the row id so two equal keys cannot collide', () => {
    expect(cursorFor(item({ id: 'item-9' }), 'alphabetical')).toEqual({
      sortKey: 'mice',
      id: 'item-9',
    });
  });
});
