import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REDUCE_MOTION,
  REDUCE_MOTION_VALUES,
  parseReduceMotion,
  resolveMotion,
} from './motion';

/**
 * The motion preference (ADR-032's value, ADR-031's parsing rules).
 *
 * Two states, a default, a parser that cannot throw, and the one place
 * either vocabulary turns into the other. The asymmetry is the point: a
 * preference may ask for *less* motion than the operating system does and
 * must never be able to ask for more.
 */

describe('the motion preference model', () => {
  it('has exactly two states', () => {
    expect([...REDUCE_MOTION_VALUES]).toStrictEqual(['system', 'always']);
  });

  it('defaults to following the system', () => {
    expect(DEFAULT_REDUCE_MOTION).toBe('system');
    expect(REDUCE_MOTION_VALUES).toContain(DEFAULT_REDUCE_MOTION);
  });

  it('offers no way to insist on motion', () => {
    // `never` would let a stored preference override an operating system
    // asking for less motion, which is a regression wearing a choice's
    // clothes. There is deliberately no such value to store.
    expect(REDUCE_MOTION_VALUES).not.toContain('never');
    expect(parseReduceMotion('never')).toBe('system');
  });
});

describe('parsing a stored motion preference', () => {
  it('accepts each state unchanged', () => {
    for (const preference of REDUCE_MOTION_VALUES) {
      expect(parseReduceMotion(preference)).toBe(preference);
    }
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['misspelled', 'Always'],
    ['a value from a newer build', 'reduced-except-popups'],
    ['the attribute value rather than the preference', 'reduced'],
    ['a boolean', true],
    ['a number', 1],
    ['an object', { motion: 'always' }],
    ['an array', ['always']],
  ])('falls back to the default for %s', (_label, value) => {
    expect(parseReduceMotion(value)).toBe('system');
  });

  it('never throws, whatever it is handed', () => {
    const hostile: unknown[] = [
      Number.NaN,
      Symbol('always'),
      (): string => 'always',
      new Map(),
      Object.create(null),
    ];

    for (const value of hostile) {
      expect(() => parseReduceMotion(value)).not.toThrow();
      expect(REDUCE_MOTION_VALUES).toContain(parseReduceMotion(value));
    }
  });
});

describe('resolving a preference to what the cascade reads', () => {
  it('leaves the question to the media query when it is `system`', () => {
    // `system` must not resolve to `reduced`: that would reduce motion for
    // every reader by default, and the operating system's own setting is
    // the thing that is supposed to decide.
    expect(resolveMotion('system')).toBe('system');
  });

  it('reduces unconditionally when it is `always`', () => {
    expect(resolveMotion('always')).toBe('reduced');
  });

  it('produces only values the stylesheet understands', () => {
    for (const preference of REDUCE_MOTION_VALUES) {
      expect(['system', 'reduced']).toContain(resolveMotion(preference));
    }
  });
});
