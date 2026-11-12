import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PREFERENCES,
  PREFERENCE_KEYS,
  PREFERENCE_VALUES,
  parsePreferences,
  resolveDefaultZoom,
  type Preferences,
} from './preferences';
import { DEFAULT_ZOOM } from './types';

/**
 * The four preferences (ADR-031).
 *
 * The parser is the only way a value gets into this subsystem, from a file
 * a reader may have edited, from a build that is newer than this one, or
 * from the renderer. So the cases below are mostly hostile ones: the
 * property being proved is not \"valid input works\" but \"nothing at all
 * throws, and nothing that is not one of the enumerated values survives\".
 */

const hostile: readonly unknown[] = [
  undefined,
  null,
  0,
  1,
  Number.NaN,
  Infinity,
  '',
  ' ',
  'true',
  [],
  ['dark'],
  {},
  { toString: (): string => 'dark' },
  new Date('2026-01-01T00:00:00.000Z'),
];

describe('the preference defaults', () => {
  it('is exactly these preferences: the four ADR-031 names, and the page colour', () => {
    expect(PREFERENCE_KEYS).toStrictEqual([
      'appearance',
      'reduceMotion',
      'defaultZoomMode',
      'showDeveloperDiagnostics',
      'pageTint',
    ]);
    expect(Object.keys(DEFAULT_PREFERENCES).sort()).toStrictEqual([...PREFERENCE_KEYS].sort());
  });

  it('defaults to following the system and changing nothing else', () => {
    expect(DEFAULT_PREFERENCES).toStrictEqual({
      appearance: 'system',
      reduceMotion: 'system',
      defaultZoomMode: 'fit-width',
      showDeveloperDiagnostics: 'off',
      pageTint: 'original',
    });
  });

  it('starts the diagnostics disclosure closed, as 6.4 designed it', () => {
    // A mutant that flips this default would otherwise pass every test
    // about the panel itself: the panel behaves identically either way.
    expect(DEFAULT_PREFERENCES.showDeveloperDiagnostics).toBe('off');
  });
});

describe('the preference alphabet', () => {
  /*
   * ADR-031's privacy claim is structural: the settings subsystem cannot
   * store a secret because the complete set of values it can hold is
   * eleven enumerated strings. These tests are what makes that a checked
   * property rather than a sentence in a document.
   */

  it('declares a closed set of values for every preference', () => {
    expect(Object.keys(PREFERENCE_VALUES).sort()).toStrictEqual([...PREFERENCE_KEYS].sort());
    expect(Object.values(PREFERENCE_VALUES).flat()).toStrictEqual([
      'system',
      'light',
      'dark',
      'system',
      'always',
      'fit-width',
      'fit-page',
      'last-used',
      'off',
      'on',
      'original',
      'sepia',
      'dimmed',
      'dark',
    ]);
  });

  it('can hold nothing that looks like a secret, a path or an address', () => {
    const everything = Object.values(PREFERENCE_VALUES).flat();

    for (const value of everything) {
      expect(value).toMatch(/^[a-z-]+$/);
      expect(value.length).toBeLessThanOrEqual(12);
    }

    expect(everything.some((value) => value.includes('/'))).toBe(false);
    expect(everything.some((value) => value.includes(':'))).toBe(false);
    expect(everything.some((value) => value.includes('.'))).toBe(false);
    expect(everything.some((value) => value.includes('@'))).toBe(false);
  });

  it('parses every declared value back to itself', () => {
    for (const key of PREFERENCE_KEYS) {
      for (const value of PREFERENCE_VALUES[key]) {
        expect(parsePreferences({ [key]: value })[key]).toBe(value);
      }
    }
  });
});

describe('parsing stored preferences', () => {
  it('accepts a complete, valid block unchanged', () => {
    const stored: Preferences = {
      appearance: 'dark',
      reduceMotion: 'always',
      defaultZoomMode: 'fit-page',
      showDeveloperDiagnostics: 'on',
      pageTint: 'sepia',
    };

    expect(parsePreferences(stored)).toStrictEqual(stored);
  });

  it('answers with the defaults for anything that is not an object', () => {
    for (const value of hostile) {
      expect(parsePreferences(value)).toStrictEqual(DEFAULT_PREFERENCES);
    }
  });

  it('never throws, whatever it is given', () => {
    for (const value of hostile) {
      expect(() => parsePreferences(value)).not.toThrow();
    }
  });

  it('repairs one field without touching the others', () => {
    expect(
      parsePreferences({
        appearance: 'dark',
        reduceMotion: 'sometimes',
        defaultZoomMode: 'fit-page',
        showDeveloperDiagnostics: 'on',
        pageTint: 'sepia',
      }),
    ).toStrictEqual({
      appearance: 'dark',
      reduceMotion: 'system',
      defaultZoomMode: 'fit-page',
      showDeveloperDiagnostics: 'on',
      pageTint: 'sepia',
    });
  });

  it('fills in a partial block rather than rejecting it', () => {
    expect(parsePreferences({ appearance: 'light' })).toStrictEqual({
      ...DEFAULT_PREFERENCES,
      appearance: 'light',
    });
  });

  it('rejects the right spelling in the wrong case', () => {
    // Values are compared exactly. \"Dark\" is not \"dark\": accepting it
    // would mean two spellings of one value could both end up on disk.
    expect(parsePreferences({ appearance: 'Dark' }).appearance).toBe('system');
    expect(parsePreferences({ reduceMotion: 'ALWAYS' }).reduceMotion).toBe('system');
    expect(parsePreferences({ defaultZoomMode: 'Fit-Width' }).defaultZoomMode).toBe('fit-width');
    expect(parsePreferences({ showDeveloperDiagnostics: 'ON' }).showDeveloperDiagnostics).toBe(
      'off',
    );
  });

  it('rejects an empty string, a number, an object and an array in every field', () => {
    for (const key of PREFERENCE_KEYS) {
      for (const value of ['', 42, {}, [], null, true]) {
        expect(parsePreferences({ [key]: value })[key]).toBe(DEFAULT_PREFERENCES[key]);
      }
    }
  });

  it('drops a key it does not know rather than carrying it', () => {
    const parsed = parsePreferences({
      appearance: 'dark',
      apiKey: 'sk-not-a-preference',
      providerUrl: 'https://example.invalid/v1',
      documentPath: '/home/reader/secret.pdf',
    });

    expect(parsed).toStrictEqual({ ...DEFAULT_PREFERENCES, appearance: 'dark' });
    expect(Object.keys(parsed)).toStrictEqual([...PREFERENCE_KEYS]);
    expect(JSON.stringify(parsed)).not.toContain('sk-not-a-preference');
    expect(JSON.stringify(parsed)).not.toContain('example.invalid');
    expect(JSON.stringify(parsed)).not.toContain('secret.pdf');
  });

  it('ignores a prototype-polluting key', () => {
    const parsed = parsePreferences(JSON.parse('{"__proto__": {"appearance": "dark"}}'));

    expect(parsed).toStrictEqual(DEFAULT_PREFERENCES);
    expect({}).not.toHaveProperty('appearance');
  });
});

describe('the zoom a new document opens at', () => {
  const lastUsed = { mode: 'fixed', scale: 1.75 } as const;

  it('answers each mode with a zoom of the existing shape', () => {
    expect(resolveDefaultZoom('fit-width', null)).toStrictEqual({
      mode: 'fit-width',
      scale: DEFAULT_ZOOM.scale,
    });
    expect(resolveDefaultZoom('fit-page', null)).toStrictEqual({
      mode: 'fit-page',
      scale: DEFAULT_ZOOM.scale,
    });
  });

  it('uses the zoom of the last document read for last-used', () => {
    expect(resolveDefaultZoom('last-used', lastUsed)).toStrictEqual(lastUsed);
  });

  it('falls back to the default when nothing has been read yet', () => {
    expect(resolveDefaultZoom('last-used', null)).toStrictEqual(DEFAULT_ZOOM);
  });

  it('ignores the last-used zoom for the two fitting modes', () => {
    expect(resolveDefaultZoom('fit-width', lastUsed).mode).toBe('fit-width');
    expect(resolveDefaultZoom('fit-page', lastUsed).mode).toBe('fit-page');
  });
});
