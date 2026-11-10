import { describe, expect, it } from 'vitest';

import {
  APPEARANCES,
  DEFAULT_APPEARANCE,
  parseAppearance,
  resolveAppearance,
  type Appearance,
} from './appearance';

/**
 * The appearance value (ADR-030 model, ADR-031 parsing rules).
 *
 * Three states, a default, and a parser that cannot throw. The resolution
 * function is the only place either process turns `system` into a palette,
 * so the table below is the whole of the theme model's logic.
 */

describe('the appearance model', () => {
  it('has exactly three states', () => {
    expect([...APPEARANCES]).toStrictEqual(['system', 'light', 'dark']);
  });

  it('defaults to following the system', () => {
    expect(DEFAULT_APPEARANCE).toBe('system');
    expect(APPEARANCES).toContain(DEFAULT_APPEARANCE);
  });
});

describe('parsing a stored appearance', () => {
  it('accepts each of the three states unchanged', () => {
    for (const appearance of APPEARANCES) {
      expect(parseAppearance(appearance)).toBe(appearance);
    }
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['misspelled', 'Light'],
    ['a value from a newer build', 'sepia'],
    ['a number', 1],
    ['a boolean', true],
    ['an object', { appearance: 'dark' }],
    ['an array', ['dark']],
  ])('falls back to the default for %s', (_label, value) => {
    expect(parseAppearance(value)).toBe('system');
  });

  it('never throws, whatever it is handed', () => {
    const hostile: unknown[] = [
      Number.NaN,
      Symbol('dark'),
      (): string => 'dark',
      new Map(),
      Object.create(null),
    ];

    for (const value of hostile) {
      expect(() => parseAppearance(value)).not.toThrow();
      expect(APPEARANCES).toContain(parseAppearance(value));
    }
  });
});

describe('resolving an appearance to a palette', () => {
  const cases: ReadonlyArray<readonly [Appearance, boolean, 'light' | 'dark']> = [
    ['system', true, 'dark'],
    ['system', false, 'light'],
    ['light', true, 'light'],
    ['light', false, 'light'],
    ['dark', true, 'dark'],
    ['dark', false, 'dark'],
  ];

  it.each(cases)('%s with systemPrefersDark=%s resolves to %s', (appearance, dark, expected) => {
    expect(resolveAppearance(appearance, dark)).toBe(expected);
  });

  it('lets an explicit choice ignore the system entirely', () => {
    // The property that makes an override an override: for `light` and
    // `dark`, the system value is not an input at all.
    for (const appearance of ['light', 'dark'] as const) {
      expect(resolveAppearance(appearance, true)).toBe(resolveAppearance(appearance, false));
    }

    expect(resolveAppearance('system', true)).not.toBe(resolveAppearance('system', false));
  });
});
