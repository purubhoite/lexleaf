import { describe, expect, it } from 'vitest';

import {
  addHighlight,
  annotationsFileName,
  annotationsToMarkdown,
  EMPTY_ANNOTATIONS,
  highlightAt,
  isBookmarked,
  isEmptyAnnotations,
  MAX_NOTE_LENGTH,
  parseDocumentAnnotations,
  removeHighlight,
  rotateBy,
  toggleBookmark,
  updateHighlight,
  type DocumentAnnotations,
  type NewHighlight,
} from './annotations';

const AT = '2026-11-12T10:00:00.000Z';

const fresh = (overrides: Partial<NewHighlight> = {}): NewHighlight => ({
  id: 'h1',
  page: 3,
  start: 10,
  end: 20,
  text: 'ten letters',
  colour: 'yellow',
  at: AT,
  ...overrides,
});

const withOne = (overrides: Partial<NewHighlight> = {}): DocumentAnnotations =>
  addHighlight(EMPTY_ANNOTATIONS, fresh(overrides));

describe('reading annotations from disk or from the window', () => {
  it('returns an empty set for anything that is not one', () => {
    for (const value of [null, undefined, 'x', 7, [], { highlights: 'no' }]) {
      expect(parseDocumentAnnotations(value)).toStrictEqual(EMPTY_ANNOTATIONS);
    }
  });

  it('keeps a well-formed set exactly', () => {
    const stored = toggleBookmark(withOne(), 5, 'Chapter 2', AT);

    expect(parseDocumentAnnotations(JSON.parse(JSON.stringify(stored)))).toStrictEqual(stored);
  });

  it('drops what it cannot make sense of and keeps the rest', () => {
    const parsed = parseDocumentAnnotations({
      highlights: [
        { ...withOne().highlights[0] },
        { id: 'bad-range', page: 1, start: 9, end: 9, text: '', colour: 'yellow', createdAt: AT },
        { id: 'bad-colour', page: 1, start: 0, end: 4, text: 'x', colour: 'red', createdAt: AT },
        { id: 'bad-page', page: 0, start: 0, end: 4, text: 'x', colour: 'blue', createdAt: AT },
        { id: 'bad-date', page: 1, start: 0, end: 4, text: 'x', colour: 'blue', createdAt: 'soon' },
        'nonsense',
      ],
      bookmarks: [{ page: 2, label: 7, createdAt: AT }, { page: 'two' }, null],
      rotation: 45,
    });

    expect(parsed.highlights.map((highlight) => highlight.id)).toStrictEqual(['h1']);
    expect(parsed.bookmarks).toStrictEqual([{ page: 2, label: '', createdAt: AT }]);
    expect(parsed.rotation).toBe(0);
  });

  it('keeps one highlight per id and one bookmark per page, in reading order', () => {
    const parsed = parseDocumentAnnotations({
      highlights: [
        { id: 'b', page: 4, start: 0, end: 3, text: 'x', colour: 'pink', createdAt: AT },
        { id: 'a', page: 2, start: 5, end: 9, text: 'y', colour: 'green', createdAt: AT },
        { id: 'a', page: 9, start: 5, end: 9, text: 'z', colour: 'green', createdAt: AT },
      ],
      bookmarks: [
        { page: 8, label: 'later', createdAt: AT },
        { page: 2, label: 'first', createdAt: AT },
        { page: 8, label: 'again', createdAt: AT },
      ],
    });

    expect(parsed.highlights.map((highlight) => highlight.id)).toStrictEqual(['a', 'b']);
    expect(parsed.bookmarks.map((bookmark) => bookmark.label)).toStrictEqual(['first', 'later']);
  });

  it('cuts text that is too long instead of refusing it', () => {
    const parsed = parseDocumentAnnotations({
      highlights: [{ ...withOne().highlights[0], note: 'n'.repeat(MAX_NOTE_LENGTH + 50) }],
    });

    expect(parsed.highlights[0]?.note).toHaveLength(MAX_NOTE_LENGTH);
  });
});

describe('highlighting', () => {
  it('adds a highlight and finds it under a place in the text', () => {
    const annotations = withOne();

    expect(highlightAt(annotations, 3, 10)?.id).toBe('h1');
    expect(highlightAt(annotations, 3, 19)?.id).toBe('h1');
    expect(highlightAt(annotations, 3, 20)).toBeNull();
    expect(highlightAt(annotations, 4, 12)).toBeNull();
  });

  it('ignores an empty selection', () => {
    expect(addHighlight(EMPTY_ANNOTATIONS, fresh({ start: 5, end: 5 }))).toBe(EMPTY_ANNOTATIONS);
  });

  it('merges an overlapping highlight into one, keeping the notes', () => {
    const noted = updateHighlight(withOne(), 'h1', { note: 'remember this' });
    const merged = addHighlight(
      noted,
      fresh({ id: 'h2', start: 15, end: 30, text: 'overlap', colour: 'green' }),
    );

    expect(merged.highlights).toHaveLength(1);
    expect(merged.highlights[0]).toMatchObject({
      id: 'h2',
      start: 10,
      end: 30,
      colour: 'green',
      note: 'remember this',
    });
  });

  it('keeps the fuller text when the new selection lies inside an old highlight', () => {
    const merged = addHighlight(
      withOne(),
      fresh({ id: 'h2', start: 12, end: 15, text: 'in', colour: 'pink' }),
    );

    expect(merged.highlights[0]).toMatchObject({ start: 10, end: 20, text: 'ten letters' });
  });

  it('leaves highlights on other pages and elsewhere on the page alone', () => {
    const two = addHighlight(withOne(), fresh({ id: 'h2', start: 20, end: 25 }));
    const three = addHighlight(two, fresh({ id: 'h3', page: 4 }));

    expect(three.highlights.map((highlight) => highlight.id)).toStrictEqual(['h1', 'h2', 'h3']);
  });

  it('changes a colour or a note without touching the other, and removes', () => {
    const recoloured = updateHighlight(withOne(), 'h1', { colour: 'blue' });
    const noted = updateHighlight(recoloured, 'h1', { note: 'why' });

    expect(noted.highlights[0]).toMatchObject({ colour: 'blue', note: 'why' });
    expect(removeHighlight(noted, 'h1').highlights).toStrictEqual([]);
  });
});

describe('bookmarks and rotation', () => {
  it('marks a page, and unmarks it when asked again', () => {
    const marked = toggleBookmark(EMPTY_ANNOTATIONS, 7, 'Chapter 1', AT);

    expect(isBookmarked(marked, 7)).toBe(true);
    expect(isBookmarked(toggleBookmark(marked, 7, 'ignored', AT), 7)).toBe(false);
  });

  it('keeps bookmarks in page order', () => {
    const marked = toggleBookmark(toggleBookmark(EMPTY_ANNOTATIONS, 9, '', AT), 2, '', AT);

    expect(marked.bookmarks.map((bookmark) => bookmark.page)).toStrictEqual([2, 9]);
  });

  it('turns by quarter turns, either way, and comes back round', () => {
    expect(rotateBy(0, 1)).toBe(90);
    expect(rotateBy(270, 1)).toBe(0);
    expect(rotateBy(0, -1)).toBe(270);
    expect(rotateBy(90, 4)).toBe(90);
  });

  it('knows when there is nothing worth storing', () => {
    expect(isEmptyAnnotations(EMPTY_ANNOTATIONS)).toBe(true);
    expect(isEmptyAnnotations({ ...EMPTY_ANNOTATIONS, rotation: 90 })).toBe(false);
    expect(isEmptyAnnotations(withOne())).toBe(false);
  });
});

describe('exporting', () => {
  it('writes bookmarks, then highlights by page with their notes', () => {
    let annotations = withOne({ text: 'the  first\nhighlight' });

    annotations = updateHighlight(annotations, 'h1', { note: 'a note\non two lines' });
    annotations = addHighlight(annotations, fresh({ id: 'h2', page: 5, text: 'second' }));
    annotations = toggleBookmark(annotations, 4, 'Chapter 2', AT);

    expect(annotationsToMarkdown('Harbour.pdf', annotations)).toBe(
      [
        '# Notes from Harbour.pdf',
        '',
        '## Bookmarks',
        '',
        '- Page 4 — Chapter 2',
        '',
        '## Highlights',
        '',
        '### Page 3',
        '',
        '> the first highlight',
        '',
        'a note',
        'on two lines',
        '',
        '### Page 5',
        '',
        '> second',
        '',
      ].join('\n'),
    );
  });

  it('names the file after the book, safely on every system', () => {
    expect(annotationsFileName('Harbour.pdf')).toBe('Harbour - notes.md');
    expect(annotationsFileName('a/b:c*?.PDF')).toBe('a b c - notes.md');
    expect(annotationsFileName('.pdf')).toBe('book - notes.md');
  });
});
