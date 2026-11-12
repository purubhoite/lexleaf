import { describe, expect, it } from 'vitest';

import { textPresenceSamplePages } from './textPresence';

describe('the pages sampled for text', () => {
  it('is every page of a short document', () => {
    expect(textPresenceSamplePages(1)).toStrictEqual([1]);
    expect(textPresenceSamplePages(4)).toStrictEqual([1, 2, 3, 4]);
    expect(textPresenceSamplePages(6)).toStrictEqual([1, 2, 3, 4, 5, 6]);
  });

  it('is the first, the last and an even spread of a long one', () => {
    expect(textPresenceSamplePages(101)).toStrictEqual([1, 21, 41, 61, 81, 101]);
    expect(textPresenceSamplePages(7)).toStrictEqual([1, 2, 3, 5, 6, 7]);

    const pages = textPresenceSamplePages(5_000);

    expect(pages).toHaveLength(6);
    expect(pages[0]).toBe(1);
    expect(pages.at(-1)).toBe(5_000);
  });

  it('never names a page outside the document, or the same page twice', () => {
    for (let pageCount = 1; pageCount <= 200; pageCount += 1) {
      const pages = textPresenceSamplePages(pageCount);

      expect(new Set(pages).size).toBe(pages.length);
      expect(pages.every((page) => Number.isInteger(page) && page >= 1 && page <= pageCount)).toBe(
        true,
      );
    }
  });

  it('is nothing for a document with no pages', () => {
    expect(textPresenceSamplePages(0)).toStrictEqual([]);
    expect(textPresenceSamplePages(-3)).toStrictEqual([]);
    expect(textPresenceSamplePages(2.5)).toStrictEqual([]);
    expect(textPresenceSamplePages(10, 0)).toStrictEqual([]);
    expect(textPresenceSamplePages(10, 1)).toStrictEqual([1]);
  });
});
