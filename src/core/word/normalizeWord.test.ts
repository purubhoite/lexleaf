import { describe, expect, it } from 'vitest';

import { normalizeWord } from './normalizeWord';

describe('normalizeWord', () => {
  it('lowercases the word', () => {
    expect(normalizeWord('Ambivalence')).toBe('ambivalence');
    expect(normalizeWord('PDF')).toBe('pdf');
  });

  it('removes surrounding punctuation', () => {
    expect(normalizeWord('(ambivalence),')).toBe('ambivalence');
    expect(normalizeWord('\u201Cquoted\u201D')).toBe('quoted');
    expect(normalizeWord('word...')).toBe('word');
  });

  it('converts typographic apostrophes to the straight form', () => {
    expect(normalizeWord('don\u2019t')).toBe("don't");
    expect(normalizeWord('o\u02BCclock')).toBe("o'clock");
  });

  it('drops a trailing possessive apostrophe', () => {
    expect(normalizeWord("users'")).toBe('users');
    expect(normalizeWord('users\u2019')).toBe('users');
  });

  it('keeps hyphens inside compounds', () => {
    expect(normalizeWord('Well-Known')).toBe('well-known');
  });

  it('expands ligatures so the lookup form matches a dictionary headword', () => {
    expect(normalizeWord('\uFB01nd')).toBe('find');
    expect(normalizeWord('\uFB02ourish')).toBe('flourish');
    expect(normalizeWord('e\uFB00ort')).toBe('effort');
  });

  it('removes soft hyphens', () => {
    expect(normalizeWord('recon\u00ADsidered')).toBe('reconsidered');
  });

  it('preserves diacritics and non-Latin scripts', () => {
    expect(normalizeWord('Café')).toBe('café');
    expect(normalizeWord('cafe\u0301')).toBe('café');
    expect(normalizeWord('\u0427\u0442\u0435\u043D\u0438\u0435')).toBe(
      '\u0447\u0442\u0435\u043D\u0438\u0435',
    );
    expect(normalizeWord('Stra\u00DFe')).toBe('stra\u00DFe');
  });

  it('returns an empty string when nothing lexical remains', () => {
    expect(normalizeWord('\u2014')).toBe('');
    expect(normalizeWord('...')).toBe('');
    expect(normalizeWord('')).toBe('');
  });

  it('does not alter the raw input', () => {
    const raw = '\u201CCaf\u00E9,\u201D';

    normalizeWord(raw);

    expect(raw).toBe('\u201CCaf\u00E9,\u201D');
  });
});
