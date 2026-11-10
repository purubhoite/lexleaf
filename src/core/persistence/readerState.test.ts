import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES } from './preferences';
import {
  CURRENT_SCHEMA_VERSION,
  emptyReaderState,
  findDocument,
  forgetDocument,
  lastOpenedDocument,
  lastUsedZoom,
  rememberOpen,
  rememberPosition,
  rememberPreferences,
  RECENT_DOCUMENT_LIMIT,
  type OpenedDocumentFacts,
} from './readerState';
import { DEFAULT_ZOOM, START_OF_DOCUMENT, type ReaderState } from './types';

const facts = (overrides: Partial<OpenedDocumentFacts> = {}): OpenedDocumentFacts => ({
  id: 'id-a',
  path: '/books/a.pdf',
  name: 'a.pdf',
  sizeBytes: 1_024,
  pageCount: 10,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const withOpens = (count: number): ReaderState => {
  let state = emptyReaderState();

  for (let index = 1; index <= count; index += 1) {
    state = rememberOpen(
      state,
      facts({
        id: `id-${String(index)}`,
        path: `/books/${String(index)}.pdf`,
        name: `${String(index)}.pdf`,
      }),
    );
  }

  return state;
};

describe('reader state', () => {
  it('starts empty at the current schema version', () => {
    expect(emptyReaderState()).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      documents: [],
      // 6.8: an empty state still has a complete preference block, so no
      // caller ever has to cope with a half-populated one.
      preferences: DEFAULT_PREFERENCES,
    });
    expect(lastOpenedDocument(emptyReaderState())).toBeNull();
  });

  it('records an open at the start of the document, most recent first', () => {
    const state = withOpens(3);

    expect(state.documents.map((document) => document.id)).toEqual(['id-3', 'id-2', 'id-1']);
    expect(lastOpenedDocument(state)?.id).toBe('id-3');
    expect(state.documents[0]?.position).toEqual(START_OF_DOCUMENT);
  });

  it('moves a document already in the list to the front without duplicating it', () => {
    const state = rememberOpen(withOpens(3), facts({ id: 'id-1', path: '/books/1.pdf' }));

    expect(state.documents.map((document) => document.id)).toEqual(['id-1', 'id-3', 'id-2']);
  });

  it('keeps the remembered position when the same document is opened again', () => {
    const opened = rememberOpen(emptyReaderState(), facts());
    const read = rememberPosition(opened, 'id-a', {
      page: 7,
      pageOffsetFraction: 0.25,
      zoom: { mode: 'fixed', scale: 1.5 },
    });
    const reopened = rememberOpen(read, facts({ at: '2026-02-02T00:00:00.000Z' }));

    expect(reopened.documents[0]?.position).toEqual({
      page: 7,
      pageOffsetFraction: 0.25,
      zoom: { mode: 'fixed', scale: 1.5 },
    });
    expect(reopened.documents[0]?.lastOpenedAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it('refreshes the path and name of a document that was moved or renamed', () => {
    const opened = rememberOpen(emptyReaderState(), facts());
    const moved = rememberOpen(
      opened,
      facts({ path: '/archive/renamed.pdf', name: 'renamed.pdf' }),
    );

    expect(moved.documents).toHaveLength(1);
    expect(moved.documents[0]).toMatchObject({
      path: '/archive/renamed.pdf',
      name: 'renamed.pdf',
    });
  });

  it('keeps a known page count when a later open does not know it yet', () => {
    const opened = rememberOpen(emptyReaderState(), facts({ pageCount: 42 }));
    const reopened = rememberOpen(opened, facts({ pageCount: null }));

    expect(reopened.documents[0]?.pageCount).toBe(42);
  });

  it('bounds the recent list and drops the oldest entry', () => {
    const state = withOpens(RECENT_DOCUMENT_LIMIT + 5);

    expect(state.documents).toHaveLength(RECENT_DOCUMENT_LIMIT);
    expect(state.documents[0]?.id).toBe(`id-${String(RECENT_DOCUMENT_LIMIT + 5)}`);
    expect(findDocument(state, 'id-1')).toBeNull();
    expect(findDocument(state, 'id-5')).toBeNull();
    expect(findDocument(state, 'id-6')).not.toBeNull();
  });

  it('updates a position without reordering the list', () => {
    const state = rememberPosition(withOpens(3), 'id-1', {
      page: 4,
      pageOffsetFraction: 0.5,
      zoom: DEFAULT_ZOOM,
    });

    expect(state.documents.map((document) => document.id)).toEqual(['id-3', 'id-2', 'id-1']);
    expect(findDocument(state, 'id-1')?.position.page).toBe(4);
  });

  it('learns the page count alongside a position', () => {
    const state = rememberPosition(withOpens(1), 'id-1', START_OF_DOCUMENT, 128);

    expect(findDocument(state, 'id-1')?.pageCount).toBe(128);
  });

  it('ignores a position for a document it has never recorded', () => {
    const state = withOpens(2);
    const unchanged = rememberPosition(state, 'never-seen', START_OF_DOCUMENT);

    expect(unchanged.documents).toEqual(state.documents);
  });

  it('forgets a document, and forgetting an unknown one changes nothing', () => {
    const state = withOpens(3);

    expect(forgetDocument(state, 'id-2').documents.map((document) => document.id)).toEqual([
      'id-3',
      'id-1',
    ]);
    expect(forgetDocument(state, 'absent').documents).toEqual(state.documents);
  });

  it('never mutates the state it is given', () => {
    const state = withOpens(2);
    const snapshot = JSON.stringify(state);

    rememberOpen(state, facts({ id: 'id-new' }));
    rememberPosition(state, 'id-1', { page: 9, pageOffsetFraction: 1, zoom: DEFAULT_ZOOM });
    forgetDocument(state, 'id-1');

    expect(JSON.stringify(state)).toBe(snapshot);
  });
  /* ---------------------------------------------------------------- *
   * Preferences (ADR-031, 6.8)
   * ---------------------------------------------------------------- */

  it('stores the preferences without touching the documents', () => {
    const state = withOpens(2);
    const next = rememberPreferences(state, {
      ...DEFAULT_PREFERENCES,
      appearance: 'dark',
      defaultZoomMode: 'last-used',
    });

    expect(next.preferences.appearance).toBe('dark');
    expect(next.preferences.defaultZoomMode).toBe('last-used');
    expect(next.documents).toEqual(state.documents);
    expect(state.preferences).toStrictEqual(DEFAULT_PREFERENCES);
  });

  it('keeps the preferences through every document write', () => {
    /*
     * The failure this rules out is the quiet one: a document operation
     * that builds a fresh state object and drops the block beside it, so
     * a reader's appearance resets the next time they open a file.
     */
    const chosen = { ...DEFAULT_PREFERENCES, appearance: 'light', reduceMotion: 'always' } as const;
    let state = rememberPreferences(withOpens(2), chosen);

    state = rememberOpen(state, facts({ id: 'id-new', path: '/books/new.pdf' }));
    expect(state.preferences).toStrictEqual(chosen);

    state = rememberPosition(state, 'id-new', {
      page: 4,
      pageOffsetFraction: 0.25,
      zoom: { mode: 'fixed', scale: 1.5 },
    });
    expect(state.preferences).toStrictEqual(chosen);

    state = forgetDocument(state, 'id-1');
    expect(state.preferences).toStrictEqual(chosen);
  });

  it('reports the zoom of the document read most recently', () => {
    const state = rememberPosition(withOpens(2), 'id-2', {
      page: 1,
      pageOffsetFraction: 0,
      zoom: { mode: 'fixed', scale: 2 },
    });

    expect(lastUsedZoom(state)).toEqual({ mode: 'fixed', scale: 2 });
  });

  it('has no last-used zoom before anything has been opened', () => {
    expect(lastUsedZoom(emptyReaderState())).toBeNull();
  });

  it('can leave the document being opened out of the answer', () => {
    /*
     * The service records an open before anything asks what zoom to use,
     * so the most recent document is the one being opened and its
     * position is the start of the document. Excluding it by identity is
     * what keeps `last-used` meaning the document read before this one.
     */
    const read = rememberPosition(withOpens(1), 'id-1', {
      page: 2,
      pageOffsetFraction: 0,
      zoom: { mode: 'fixed', scale: 1.75 },
    });
    const afterOpeningAnother = rememberOpen(read, facts({ id: 'id-2', path: '/books/b.pdf' }));

    expect(lastUsedZoom(afterOpeningAnother)).toEqual(DEFAULT_ZOOM);
    expect(lastUsedZoom(afterOpeningAnother, 'id-2')).toEqual({ mode: 'fixed', scale: 1.75 });
  });

  it('has no last-used zoom when the only document is the excluded one', () => {
    const read = rememberPosition(withOpens(1), 'id-1', {
      page: 2,
      pageOffsetFraction: 0,
      zoom: { mode: 'fixed', scale: 1.75 },
    });

    expect(lastUsedZoom(read, 'id-1')).toBeNull();
  });

  it('skips only the excluded document, not every earlier one', () => {
    const read = rememberPosition(withOpens(3), 'id-2', {
      page: 1,
      pageOffsetFraction: 0,
      zoom: { mode: 'fit-page', scale: 1 },
    });

    // Most recent first: id-3, id-2, id-1. Excluding the head falls to
    // the next document, and no further.
    expect(lastUsedZoom(read, 'id-3')).toEqual({ mode: 'fit-page', scale: 1 });
  });

  it('ignores an identity that is not in the state', () => {
    const read = rememberPosition(withOpens(2), 'id-2', {
      page: 1,
      pageOffsetFraction: 0,
      zoom: { mode: 'fixed', scale: 1.25 },
    });

    expect(lastUsedZoom(read, 'id-unknown')).toEqual({ mode: 'fixed', scale: 1.25 });
  });
});
