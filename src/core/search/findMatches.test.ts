import { describe, expect, it } from 'vitest';

import {
  buildSearchPattern,
  findMatchesInText,
  firstMatchFromPage,
  isRunnableQuery,
  MAX_MATCHES_PER_PAGE,
  stepMatch,
} from './findMatches';
import type { SearchMatch, SearchQuery } from './types';

const query = (text: string, caseSensitive = false): SearchQuery => ({ text, caseSensitive });

const found = (text: string, needle: string, caseSensitive = false): readonly string[] =>
  findMatchesInText(text, 1, query(needle, caseSensitive)).map((match) =>
    text.slice(match.start, match.end),
  );

describe('search over extracted text', () => {
  it('knows which queries are worth running', () => {
    expect(isRunnableQuery(query(''))).toBe(false);
    expect(isRunnableQuery(query('   '))).toBe(false);
    expect(isRunnableQuery(query('a'))).toBe(true);
  });

  it('returns nothing for an empty query rather than matching everywhere', () => {
    expect(buildSearchPattern(query('  '))).toBeNull();
    expect(findMatchesInText('anything at all', 1, query(''))).toEqual([]);
  });

  it('finds every occurrence, including repeats on the same line', () => {
    const matches = findMatchesInText('the cat sat on the mat, the end', 3, query('the'));

    expect(matches).toHaveLength(3);
    expect(matches.map((match) => match.start)).toEqual([0, 15, 24]);
    expect(matches.every((match) => match.pageNumber === 3)).toBe(true);
  });

  it('ignores case by default and respects it when asked', () => {
    expect(found('Harbour harbour HARBOUR', 'harbour')).toHaveLength(3);
    expect(found('Harbour harbour HARBOUR', 'harbour', true)).toEqual(['harbour']);
  });

  it('matches punctuation literally rather than as pattern syntax', () => {
    expect(found('a.b and axb', 'a.b')).toEqual(['a.b']);
    expect(found('costs $5 (today)', '(today)')).toEqual(['(today)']);
    expect(found('one+two', '+')).toEqual(['+']);
  });

  it('matches a phrase broken across a line, because the text layer inserts breaks', () => {
    const text = 'the quick brown\nfox jumps';

    expect(found(text, 'brown fox')).toEqual(['brown\nfox']);
    expect(found(text, 'quick   brown')).toEqual(['quick brown']);
  });

  it('folds typographic apostrophes so a keyboard query matches the page', () => {
    expect(found('it is a sailor\u2019s knot', "sailor's")).toEqual(['sailor\u2019s']);
    expect(found("a sailor's knot", 'sailor\u2019s')).toEqual(["sailor's"]);
  });

  it('reports offsets that index the original, unfolded page text', () => {
    const text = 'a\u2019b needle here';
    const [match] = findMatchesInText(text, 1, query('needle'));

    expect(match).toBeDefined();
    expect(text.slice(match?.start ?? 0, match?.end ?? 0)).toBe('needle');
  });

  it('gives each match a collapsed preview with ellipses where it was cut', () => {
    const text = `${'x '.repeat(40)}needle${' y'.repeat(40)}`;
    const [match] = findMatchesInText(text, 1, query('needle'));

    expect(match?.preview).toContain('needle');
    expect(match?.preview.startsWith('…')).toBe(true);
    expect(match?.preview.endsWith('…')).toBe(true);
    expect(match?.preview).not.toContain('\n');
  });

  it('does not add ellipses when the whole page is shown', () => {
    const [match] = findMatchesInText('short needle line', 1, query('needle'));

    expect(match?.preview).toBe('short needle line');
  });

  it('returns nothing when the query is absent', () => {
    expect(findMatchesInText('nothing to see', 1, query('absent'))).toEqual([]);
  });

  it('caps the matches reported for a single page', () => {
    const text = 'a '.repeat(MAX_MATCHES_PER_PAGE + 50);

    expect(findMatchesInText(text, 1, query('a'))).toHaveLength(MAX_MATCHES_PER_PAGE);
  });

  it('does not overlap matches of a self-overlapping query', () => {
    const matches = findMatchesInText('aaaa', 1, query('aa'));

    expect(matches.map((match) => match.start)).toEqual([0, 2]);
  });

  it('starts from the reader’s page and falls back to the first match', () => {
    const matches: readonly SearchMatch[] = [
      { pageNumber: 2, start: 0, end: 1, preview: '' },
      { pageNumber: 5, start: 0, end: 1, preview: '' },
      { pageNumber: 9, start: 0, end: 1, preview: '' },
    ];

    expect(firstMatchFromPage(matches, 1)).toBe(0);
    expect(firstMatchFromPage(matches, 5)).toBe(1);
    expect(firstMatchFromPage(matches, 6)).toBe(2);
    expect(firstMatchFromPage(matches, 50)).toBe(0);
    expect(firstMatchFromPage([], 1)).toBeNull();
  });

  it('wraps at both ends when stepping through matches', () => {
    expect(stepMatch(3, 0, 1)).toBe(1);
    expect(stepMatch(3, 2, 1)).toBe(0);
    expect(stepMatch(3, 0, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(0);
  });
});
