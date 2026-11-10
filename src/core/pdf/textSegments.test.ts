import { describe, expect, it } from 'vitest';

import { hasExtractableText, itemsToSegments } from './textSegments';

describe('itemsToSegments', () => {
  it('turns text items into segments', () => {
    expect(
      itemsToSegments([
        { str: 'Hello', hasEOL: false },
        { str: ' world', hasEOL: true },
      ]),
    ).toEqual([
      { text: 'Hello', endsLine: false },
      { text: ' world', endsLine: true },
    ]);
  });

  it('applies a standalone end-of-line item to the preceding segment', () => {
    // PDF.js emits an empty item carrying only hasEOL for some documents; the
    // text layer renders it as a line break after the previous element.
    expect(
      itemsToSegments([
        { str: 'Hello', hasEOL: false },
        { str: '', hasEOL: true },
      ]),
    ).toEqual([{ text: 'Hello', endsLine: true }]);
  });

  it('ignores an end-of-line item that has no preceding segment', () => {
    expect(itemsToSegments([{ str: '', hasEOL: true }])).toEqual([]);
  });

  it('ignores empty items without an end-of-line flag', () => {
    expect(
      itemsToSegments([
        { str: '', hasEOL: false },
        { str: 'a', hasEOL: false },
      ]),
    ).toEqual([{ text: 'a', endsLine: false }]);
  });

  it('skips marked-content boundaries, which carry no text', () => {
    expect(itemsToSegments([{ str: 'a' }, {}, { str: 'b' }])).toEqual([
      { text: 'a', endsLine: false },
      { text: 'b', endsLine: false },
    ]);
  });

  it('keeps space-only runs, which carry the gaps between words', () => {
    expect(itemsToSegments([{ str: 'a' }, { str: ' ' }, { str: 'b' }])).toHaveLength(3);
  });
});

describe('hasExtractableText', () => {
  it('is false for a page with no segments', () => {
    expect(hasExtractableText([])).toBe(false);
  });

  it('is false for a page whose only segments are whitespace', () => {
    expect(hasExtractableText([{ text: '  ', endsLine: true }])).toBe(false);
  });

  it('is true as soon as one segment carries text', () => {
    expect(
      hasExtractableText([
        { text: ' ', endsLine: false },
        { text: 'word', endsLine: true },
      ]),
    ).toBe(true);
  });
});
