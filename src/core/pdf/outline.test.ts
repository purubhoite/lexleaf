import { describe, expect, it, vi } from 'vitest';

import {
  OUTLINE_MAXIMUM_DEPTH,
  OUTLINE_MAXIMUM_ENTRIES,
  OUTLINE_MAXIMUM_TITLE_LENGTH,
  activeOutlineIndex,
  flattenOutline,
  type PdfOutlineEntry,
} from './outline';

/** Destinations in these tests are simply the page number they stand for. */
const byNumber = (destination: unknown): Promise<number | null> =>
  Promise.resolve(typeof destination === 'number' ? destination : null);

describe('flattening an outline', () => {
  it('lists entries in reading order with their depth and page', async () => {
    const outline = [
      {
        title: 'Part One',
        dest: 1,
        items: [
          { title: 'Chapter 1', dest: 3, items: [{ title: 'A digression', dest: 7, items: [] }] },
          { title: 'Chapter 2', dest: 20, items: [] },
        ],
      },
      { title: 'Part Two', dest: 60, items: [] },
    ];

    await expect(flattenOutline(outline, 100, byNumber)).resolves.toStrictEqual([
      { title: 'Part One', pageNumber: 1, depth: 0 },
      { title: 'Chapter 1', pageNumber: 3, depth: 1 },
      { title: 'A digression', pageNumber: 7, depth: 2 },
      { title: 'Chapter 2', pageNumber: 20, depth: 1 },
      { title: 'Part Two', pageNumber: 60, depth: 0 },
    ]);
  });

  it('is empty for a document without one', async () => {
    await expect(flattenOutline(null, 10, byNumber)).resolves.toStrictEqual([]);
    await expect(flattenOutline(undefined, 10, byNumber)).resolves.toStrictEqual([]);
    await expect(flattenOutline('outline', 10, byNumber)).resolves.toStrictEqual([]);
  });

  it('keeps an entry whose destination cannot be worked out, without a page', async () => {
    const resolve = vi.fn((destination: unknown) =>
      destination === 'broken'
        ? Promise.reject(new Error('no such destination'))
        : byNumber(destination),
    );
    const outline = [
      { title: 'Nowhere', items: [] },
      { title: 'Web link', dest: null, items: [] },
      { title: 'Broken', dest: 'broken', items: [] },
      { title: 'Past the end', dest: 11, items: [] },
      { title: 'Before the start', dest: 0, items: [] },
      { title: 'Half a page', dest: 2.5, items: [] },
      { title: 'Fine', dest: 10, items: [] },
    ];

    const entries = await flattenOutline(outline, 10, resolve);

    expect(entries.map((entry) => entry.pageNumber)).toStrictEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      10,
    ]);
  });

  it('tidies titles and drops entries that have none', async () => {
    const outline = [
      { title: '  Chapter\r\n One\t\u0000 ', dest: 1, items: [] },
      { title: '   ', dest: 2, items: [{ title: 'Child of a blank entry', dest: 3, items: [] }] },
      { title: 42, dest: 4, items: [] },
      { title: 'x'.repeat(500), dest: 5, items: [] },
    ];

    const entries = await flattenOutline(outline, 10, byNumber);

    expect(entries.map((entry) => (entry.title.length > 50 ? 'long' : entry.title))).toStrictEqual([
      'Chapter One',
      'Child of a blank entry',
      'long',
    ]);
    expect(entries[1]?.depth).toBe(0);
    expect(entries[2]?.title).toHaveLength(OUTLINE_MAXIMUM_TITLE_LENGTH);
    expect(entries[2]?.title.endsWith('…')).toBe(true);
  });

  it('ignores things in the tree that are not entries', async () => {
    const outline = [null, 'text', 7, { title: 'Real', dest: 1, items: 'not a list' }];

    await expect(flattenOutline(outline, 10, byNumber)).resolves.toStrictEqual([
      { title: 'Real', pageNumber: 1, depth: 0 },
    ]);
  });

  it('stops at a bounded number of entries', async () => {
    const outline = Array.from({ length: OUTLINE_MAXIMUM_ENTRIES + 500 }, (_, index) => ({
      title: `Entry ${String(index)}`,
      dest: 1,
      items: [],
    }));

    await expect(flattenOutline(outline, 10, byNumber)).resolves.toHaveLength(
      OUTLINE_MAXIMUM_ENTRIES,
    );
  });

  it('stops at a bounded depth', async () => {
    interface Node {
      title: string;
      dest: number;
      items: Node[];
    }
    const root: Node = { title: 'Level 0', dest: 1, items: [] };
    let deepest = root;

    for (let level = 1; level < OUTLINE_MAXIMUM_DEPTH + 10; level += 1) {
      const child: Node = { title: `Level ${String(level)}`, dest: 1, items: [] };
      deepest.items.push(child);
      deepest = child;
    }

    const entries = await flattenOutline([root], 10, byNumber);

    expect(entries).toHaveLength(OUTLINE_MAXIMUM_DEPTH);
    expect(entries.at(-1)?.depth).toBe(OUTLINE_MAXIMUM_DEPTH - 1);
  });

  it('does not go round an outline that contains itself', async () => {
    interface Node {
      title: string;
      dest: number;
      items: Node[];
    }
    const a: Node = { title: 'A', dest: 1, items: [] };
    const b: Node = { title: 'B', dest: 2, items: [a] };
    a.items.push(b);

    await expect(flattenOutline([a], 10, byNumber)).resolves.toStrictEqual([
      { title: 'A', pageNumber: 1, depth: 0 },
      { title: 'B', pageNumber: 2, depth: 1 },
    ]);
  });
});

describe('the entry the reader is in', () => {
  const entries: PdfOutlineEntry[] = [
    { title: 'Part One', pageNumber: 5, depth: 0 },
    { title: 'Chapter 1', pageNumber: 5, depth: 1 },
    { title: 'A web link', pageNumber: null, depth: 1 },
    { title: 'Chapter 2', pageNumber: 20, depth: 1 },
    { title: 'See the preface', pageNumber: 2, depth: 2 },
    { title: 'Part Two', pageNumber: 60, depth: 0 },
  ];

  it('is none before the first entry', () => {
    expect(activeOutlineIndex(entries, 1)).toBe(-1);
    expect(activeOutlineIndex([], 4)).toBe(-1);
  });

  it('is the last entry that starts on or before the page', () => {
    expect(activeOutlineIndex(entries, 5)).toBe(1);
    expect(activeOutlineIndex(entries, 19)).toBe(1);
    expect(activeOutlineIndex(entries, 20)).toBe(3);
    expect(activeOutlineIndex(entries, 59)).toBe(3);
    expect(activeOutlineIndex(entries, 500)).toBe(5);
  });
});
