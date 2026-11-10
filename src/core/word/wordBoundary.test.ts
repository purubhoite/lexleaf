import { describe, expect, it } from 'vitest';

import { findWordAt } from './wordBoundary';

const wordAt = (text: string, index: number): string | null =>
  findWordAt(text, index)?.text ?? null;

describe('findWordAt', () => {
  it('returns the word covering the index', () => {
    const text = 'The quick brown fox';

    expect(wordAt(text, 4)).toBe('quick');
    expect(wordAt(text, 6)).toBe('quick');
    expect(wordAt(text, 8)).toBe('quick');
  });

  it('reports the span of the word within the text', () => {
    expect(findWordAt('The quick brown fox', 11)).toEqual({ text: 'brown', start: 10, end: 15 });
  });

  it('treats an index immediately after the final character as inside the word', () => {
    // A caret sits between characters; clicking the right half of "quick"
    // yields offset 9, which is the space.
    expect(wordAt('The quick brown fox', 9)).toBe('quick');
  });

  it('returns null for whitespace that does not touch a word on its left', () => {
    expect(wordAt('one  two', 5)).toBe('two');
    expect(wordAt('   lead', 1)).toBeNull();
  });

  it('returns null when the text has no word characters at all', () => {
    expect(wordAt('--- ...', 1)).toBeNull();
    expect(wordAt('', 0)).toBeNull();
  });

  it('rejects indexes outside the text', () => {
    expect(findWordAt('word', -1)).toBeNull();
    expect(findWordAt('word', 5)).toBeNull();
  });

  it('excludes surrounding punctuation', () => {
    expect(wordAt('(ambivalence),', 3)).toBe('ambivalence');
    expect(wordAt('"quoted"', 3)).toBe('quoted');
    expect(wordAt('ambivalence...', 2)).toBe('ambivalence');
    expect(wordAt('\u201Ccurly\u201D', 3)).toBe('curly');
  });

  it('keeps hyphenated compounds together', () => {
    expect(wordAt('a well-known example', 3)).toBe('well-known');
    expect(wordAt('a well-known example', 8)).toBe('well-known');
    expect(wordAt('state-of-the-art tooling', 9)).toBe('state-of-the-art');
  });

  it('keeps apostrophes inside words', () => {
    expect(wordAt("don't stop", 1)).toBe("don't");
    expect(wordAt('don\u2019t stop', 1)).toBe('don\u2019t');
    expect(wordAt("o'clock", 4)).toBe("o'clock");
  });

  it('drops a trailing possessive apostrophe from the raw span', () => {
    // Nothing follows the apostrophe, so it is not word-internal.
    expect(wordAt("the users' data", 5)).toBe('users');
  });

  it('does not join words across a dash or an ellipsis', () => {
    expect(wordAt('before\u2014after', 2)).toBe('before');
    expect(wordAt('before\u2014after', 8)).toBe('after');
    expect(wordAt('one--two', 1)).toBe('one');
  });

  it('does not join words across a line break', () => {
    expect(wordAt('time\nuntil', 2)).toBe('time');
    expect(wordAt('time\nuntil', 6)).toBe('until');
  });

  it('handles letters outside the Latin alphabet', () => {
    expect(wordAt('\u03B1\u03BD\u03B1\u03B3\u03BD\u03CE\u03C3\u03C4\u03B7\u03C2 text', 3)).toBe(
      '\u03B1\u03BD\u03B1\u03B3\u03BD\u03CE\u03C3\u03C4\u03B7\u03C2',
    );
    expect(wordAt('\u0447\u0442\u0435\u043D\u0438\u0435 \u0441\u043B\u043E\u0432', 2)).toBe(
      '\u0447\u0442\u0435\u043D\u0438\u0435',
    );
    expect(wordAt('ti\u1EBFng Vi\u1EC7t', 6)).toBe('Vi\u1EC7t');
  });

  it('keeps combining marks attached to their base letter', () => {
    const decomposed = 'cafe\u0301 au lait';

    expect(wordAt(decomposed, 2)).toBe('cafe\u0301');
  });

  it('treats digits and alphanumerics as words', () => {
    expect(wordAt('page 42 of 100', 6)).toBe('42');
    expect(wordAt('ISO-8601 dates', 2)).toBe('ISO-8601');
  });

  it('includes a ligature character in the word', () => {
    expect(wordAt('\uFB01nd it', 1)).toBe('\uFB01nd');
  });
});
