import { describe, expect, it } from 'vitest';

import { pickCharacterIndex, type Rect } from './pickCharacterIndex';

/**
 * A run of five characters, each ten pixels wide, on one twenty pixel tall
 * line starting at x = 100, y = 50.
 */
const rectAt = (index: number): Rect => ({
  left: 100 + index * 10,
  right: 110 + index * 10,
  top: 50,
  bottom: 70,
});

const pick = (pointerX: number, pointerY: number, caretOffset: number): number | null =>
  pickCharacterIndex({ caretOffset, length: 5, pointerX, pointerY, rectAt });

describe('pickCharacterIndex', () => {
  it('picks the character the caret precedes when the pointer is in its left half', () => {
    // Pointer over the left half of character 2; the browser reports the
    // caret before it.
    expect(pick(121, 60, 2)).toBe(2);
  });

  it('picks the preceding character when the pointer is in its right half', () => {
    // Pointer over the right half of character 1; the browser reports the
    // caret after it, which is the same offset as above.
    expect(pick(119, 60, 2)).toBe(1);
  });

  it('returns null when the pointer is past the end of the run', () => {
    // The browser still reports a caret at the end of the text.
    expect(pick(400, 60, 5)).toBeNull();
  });

  it('returns null when the pointer is before the start of the run', () => {
    expect(pick(20, 60, 0)).toBeNull();
  });

  it('returns null when the pointer is above or below the line', () => {
    expect(pick(125, 10, 2)).toBeNull();
    expect(pick(125, 200, 2)).toBeNull();
  });

  it('accepts a pointer exactly on a character boundary', () => {
    expect(pick(120, 60, 2)).toBe(2);
  });

  it('accepts the first and the last character of the run', () => {
    expect(pick(100, 60, 0)).toBe(0);
    expect(pick(149, 60, 5)).toBe(4);
  });

  it('ignores an offset outside the run', () => {
    expect(
      pickCharacterIndex({ caretOffset: 99, length: 5, pointerX: 125, pointerY: 60, rectAt }),
    ).toBeNull();
    expect(
      pickCharacterIndex({ caretOffset: -5, length: 5, pointerX: 125, pointerY: 60, rectAt }),
    ).toBeNull();
  });

  it('survives a character that cannot be measured', () => {
    expect(
      pickCharacterIndex({
        caretOffset: 2,
        length: 5,
        pointerX: 125,
        pointerY: 60,
        rectAt: () => null,
      }),
    ).toBeNull();
  });

  it('is empty-safe', () => {
    expect(
      pickCharacterIndex({ caretOffset: 0, length: 0, pointerX: 1, pointerY: 1, rectAt }),
    ).toBeNull();
  });
});
