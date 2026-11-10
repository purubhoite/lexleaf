import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES } from '@core/persistence/preferences';
import {
  emptyReaderState,
  rememberOpen,
  rememberPosition,
  rememberPreferences,
} from '@core/persistence/readerState';
import { DEFAULT_ZOOM, type ReaderState, type ZoomState } from '@core/persistence/types';
import {
  EMPTY_READER_STATE_SNAPSHOT,
  type DocumentRequestResult,
  type StateWriteHealth,
} from '@shared/ipc/contracts';

import type { ReaderStateStore } from '../persistence/readerStateStore';

import { createReaderStateService, type ReaderStateService } from './readerStateService';

/** An in-memory stand-in for the store; the store's own file rules are tested separately. */
const createStore = (
  initial: ReaderState = emptyReaderState(),
  health: StateWriteHealth = 'ok',
): ReaderStateStore & {
  readonly flushes: { count: number };
} => {
  let state = initial;
  const flushes = { count: 0 };

  return {
    flushes,
    load: (): Promise<ReaderState> => Promise.resolve(state),
    current: (): ReaderState => state,
    writeHealth: (): StateWriteHealth => health,
    update: (change): void => {
      state = change(state);
    },
    flush: (): Promise<void> => {
      flushes.count += 1;

      return Promise.resolve();
    },
  };
};

const opened = (id: string, name: string, sizeBytes = 100): DocumentRequestResult => ({
  status: 'opened',
  document: { id, name, sizeBytes, bytes: new Uint8Array([1]), position: null },
});

interface Harness {
  readonly service: ReaderStateService;
  readonly store: ReturnType<typeof createStore>;
  readonly readDocument: ReturnType<typeof vi.fn>;
  readonly exists: ReturnType<typeof vi.fn>;
}

const harness = (options: {
  readonly files?: Record<string, DocumentRequestResult>;
  readonly present?: readonly string[];
  readonly state?: ReaderState;
  readonly health?: StateWriteHealth;
}): Harness => {
  const store = createStore(options.state, options.health);
  const files = options.files ?? {};
  const readDocument = vi.fn((path: string) =>
    Promise.resolve<DocumentRequestResult>(
      files[path] ?? { status: 'unreadable', reason: 'unreadable', name: null },
    ),
  );
  const exists = vi.fn((path: string) =>
    Promise.resolve((options.present ?? Object.keys(files)).includes(path)),
  );

  return {
    store,
    readDocument,
    exists,
    service: createReaderStateService({
      store,
      readDocument,
      exists,
      now: () => new Date('2026-05-05T10:00:00.000Z'),
    }),
  };
};

describe('reader state service', () => {
  it('reports an empty snapshot before anything has been read', async () => {
    const { service } = harness({});

    await expect(service.snapshot()).resolves.toEqual(EMPTY_READER_STATE_SNAPSHOT);
  });

  it('records a successful open and offers it as the last document', async () => {
    const { service } = harness({ files: { '/books/a.pdf': opened('id-a', 'a.pdf') } });

    await service.openPath('/books/a.pdf');

    const snapshot = await service.snapshot();

    expect(snapshot.lastDocumentId).toBe('id-a');
    expect(snapshot.recents).toEqual([
      {
        id: 'id-a',
        name: 'a.pdf',
        sizeBytes: 100,
        pageCount: null,
        lastPage: 1,
        lastOpenedAt: '2026-05-05T10:00:00.000Z',
        available: true,
      },
    ]);
  });

  it('does not record an open that failed', async () => {
    const { service } = harness({});

    await expect(service.openPath('/books/missing.pdf')).resolves.toEqual({
      status: 'unreadable',
      reason: 'unreadable',
      name: null,
    });
    await expect(service.snapshot()).resolves.toMatchObject({ recents: [] });
  });

  it('attaches the remembered position when the same document is opened again', async () => {
    const { service } = harness({ files: { '/books/a.pdf': opened('id-a', 'a.pdf') } });

    await service.openPath('/books/a.pdf');
    await service.savePosition({
      documentId: 'id-a',
      position: { page: 12, pageOffsetFraction: 0.25, zoom: { mode: 'fixed', scale: 1.5 } },
      pageCount: 40,
    });

    const result = await service.openPath('/books/a.pdf');

    expect(result.status).toBe('opened');
    expect(result.status === 'opened' ? result.document.position : null).toEqual({
      page: 12,
      pageOffsetFraction: 0.25,
      zoom: { mode: 'fixed', scale: 1.5 },
    });
  });

  it('hands a new document a null position rather than someone else’s', async () => {
    const { service } = harness({
      files: { '/books/a.pdf': opened('id-a', 'a.pdf'), '/books/b.pdf': opened('id-b', 'b.pdf') },
    });

    await service.openPath('/books/a.pdf');
    await service.savePosition({
      documentId: 'id-a',
      position: { page: 9, pageOffsetFraction: 0, zoom: { mode: 'fit-width', scale: 1 } },
      pageCount: null,
    });

    const result = await service.openPath('/books/b.pdf');

    expect(result.status === 'opened' ? result.document.position : 'missing').toBeNull();
  });

  it('shows the page count and last page a document was left on', async () => {
    const { service } = harness({ files: { '/books/a.pdf': opened('id-a', 'a.pdf') } });

    await service.openPath('/books/a.pdf');
    await service.savePosition({
      documentId: 'id-a',
      position: { page: 7, pageOffsetFraction: 0.5, zoom: { mode: 'fit-width', scale: 1 } },
      pageCount: 220,
    });

    const [recent] = (await service.snapshot()).recents;

    expect(recent).toMatchObject({ lastPage: 7, pageCount: 220 });
  });

  it('orders recents most recent first', async () => {
    const { service } = harness({
      files: {
        '/books/a.pdf': opened('id-a', 'a.pdf'),
        '/books/b.pdf': opened('id-b', 'b.pdf'),
        '/books/c.pdf': opened('id-c', 'c.pdf'),
      },
    });

    await service.openPath('/books/a.pdf');
    await service.openPath('/books/b.pdf');
    await service.openPath('/books/c.pdf');
    await service.openPath('/books/a.pdf');

    expect((await service.snapshot()).recents.map((recent) => recent.id)).toEqual([
      'id-a',
      'id-c',
      'id-b',
    ]);
  });

  it('marks a recent entry whose file has disappeared as unavailable, but keeps it', async () => {
    const { service, exists } = harness({ files: { '/books/a.pdf': opened('id-a', 'a.pdf') } });

    await service.openPath('/books/a.pdf');
    exists.mockResolvedValue(false);

    const snapshot = await service.snapshot();

    expect(snapshot.recents).toHaveLength(1);
    expect(snapshot.recents[0]?.available).toBe(false);
  });

  it('reopens a recent document by id, without the renderer ever seeing a path', async () => {
    const { service, readDocument } = harness({
      files: { '/books/a.pdf': opened('id-a', 'a.pdf') },
    });

    await service.openPath('/books/a.pdf');

    const result = await service.openRecent('id-a');

    expect(result.status).toBe('opened');
    expect(readDocument).toHaveBeenLastCalledWith('/books/a.pdf');
    expect(JSON.stringify(result)).not.toContain('/books/');
  });

  it('explains, and drops the entry, when a recent document can no longer be read', async () => {
    const { service, readDocument } = harness({
      files: { '/books/a.pdf': opened('id-a', 'a.pdf') },
    });

    await service.openPath('/books/a.pdf');
    readDocument.mockResolvedValue({ status: 'unreadable', reason: 'missing', name: null });

    const result = await service.openRecent('id-a');

    /*
     * M7.2: the same two facts the sentence used to carry — which
     * document, and that it is gone — now travel as a code and a name,
     * and the renderer composes the identical sentence from them. The
     * name comes from the recent entry, so the reader is still told
     * *which* document failed, and it is still a name rather than a path.
     */
    expect(result).toEqual({
      status: 'unreadable',
      reason: 'missing',
      name: 'a.pdf',
    });
    await expect(service.snapshot()).resolves.toEqual(EMPTY_READER_STATE_SNAPSHOT);
  });

  it('refuses an id it has never recorded', async () => {
    const { service } = harness({});

    await expect(service.openRecent('id-unknown')).resolves.toEqual({
      status: 'unreadable',
      reason: 'missing',
      name: null,
    });
  });

  /* ---------------------------------------------------------------- *
   * M7.2: every write answers with the store's health
   * ---------------------------------------------------------------- */

  it('reports a healthy store after each kind of write', async () => {
    const { service } = harness({ files: { '/books/a.pdf': opened('id-a', 'a.pdf') } });

    await service.openPath('/books/a.pdf');

    await expect(
      service.savePosition({
        documentId: 'id-a',
        position: { page: 2, pageOffsetFraction: 0, zoom: DEFAULT_ZOOM },
        pageCount: 10,
      }),
    ).resolves.toBe('ok');
    await expect(service.savePreferences(DEFAULT_PREFERENCES)).resolves.toBe('ok');
    await expect(service.forget('id-a')).resolves.toBe('ok');
  });

  it('reports a failing store after each kind of write', async () => {
    const { service } = harness({
      files: { '/books/a.pdf': opened('id-a', 'a.pdf') },
      health: 'failing',
    });

    await service.openPath('/books/a.pdf');

    await expect(
      service.savePosition({
        documentId: 'id-a',
        position: { page: 2, pageOffsetFraction: 0, zoom: DEFAULT_ZOOM },
        pageCount: 10,
      }),
    ).resolves.toBe('failing');
    await expect(service.savePreferences(DEFAULT_PREFERENCES)).resolves.toBe('failing');
    await expect(service.forget('id-a')).resolves.toBe('failing');
  });

  it('still applies the change in memory when the disk is failing', async () => {
    const { service, store } = harness({ health: 'failing' });

    await service.savePreferences({ ...DEFAULT_PREFERENCES, appearance: 'dark' });

    // "Not saved" must never mean "not done": the preference is in the
    // state the application is running on, and only the disk is behind.
    expect(store.current().preferences.appearance).toBe('dark');
  });

  it('forgets a document on request', async () => {
    const { service } = harness({
      files: { '/books/a.pdf': opened('id-a', 'a.pdf'), '/books/b.pdf': opened('id-b', 'b.pdf') },
    });

    await service.openPath('/books/a.pdf');
    await service.openPath('/books/b.pdf');
    await service.forget('id-a');

    expect((await service.snapshot()).recents.map((recent) => recent.id)).toEqual(['id-b']);
  });

  it('ignores a position for a document it does not know', async () => {
    const { service } = harness({});

    await service.savePosition({
      documentId: 'id-ghost',
      position: { page: 3, pageOffsetFraction: 0, zoom: { mode: 'fit-width', scale: 1 } },
      pageCount: null,
    });

    await expect(service.snapshot()).resolves.toMatchObject({ recents: [] });
  });

  it('flushes pending writes on request', async () => {
    const { service, store } = harness({});

    await service.flush();

    expect(store.flushes.count).toBe(1);
  });
  /* ---------------------------------------------------------------- *
   * Preferences (ADR-031, 6.8)
   * ---------------------------------------------------------------- */

  it('reports the defaults before anything has been chosen', async () => {
    const { service } = harness({});

    await expect(service.preferences()).resolves.toStrictEqual(DEFAULT_PREFERENCES);
  });

  it('reads the preferences a stored state already has', async () => {
    const { service } = harness({
      state: rememberPreferences(emptyReaderState(), {
        ...DEFAULT_PREFERENCES,
        appearance: 'dark',
      }),
    });

    await expect(service.preferences()).resolves.toMatchObject({ appearance: 'dark' });
  });

  it('stores a preference and reports it back', async () => {
    const { service } = harness({});

    await service.savePreferences({
      ...DEFAULT_PREFERENCES,
      appearance: 'light',
      reduceMotion: 'always',
    });

    await expect(service.preferences()).resolves.toStrictEqual({
      ...DEFAULT_PREFERENCES,
      appearance: 'light',
      reduceMotion: 'always',
    });
  });

  it('keeps the recent documents when a preference is saved', async () => {
    const { service } = harness({ files: { '/books/a.pdf': opened('id-a', 'a.pdf') } });

    await service.openPath('/books/a.pdf');
    await service.savePreferences({ ...DEFAULT_PREFERENCES, appearance: 'dark' });

    const snapshot = await service.snapshot();

    expect(snapshot.recents.map((recent) => recent.id)).toStrictEqual(['id-a']);
    expect(snapshot.preferences.appearance).toBe('dark');
  });

  it('puts the preferences in the snapshot', async () => {
    const { service } = harness({ files: { '/books/a.pdf': opened('id-a', 'a.pdf') } });

    await service.openPath('/books/a.pdf');

    const snapshot = await service.snapshot();

    expect(snapshot.preferences).toStrictEqual(DEFAULT_PREFERENCES);
  });
});

/*
 * The zoom that answers `defaultZoomMode: 'last-used'` (ADR-031).
 *
 * These exercise the real ordering inside `openPath`: the service records
 * the open through `rememberOpen` and *then* returns the payload, so the
 * most recent document in the state is the one being opened and its
 * position is the freshly initialised `START_OF_DOCUMENT`. The 6.8
 * closure audit found the first implementation answering with precisely
 * that, which turned `last-used` into `fit-width`. Nothing here injects a
 * last-used zoom: every value comes out of the service.
 */
describe('the last-used zoom sent with an open', () => {
  const ZOOMED: ZoomState = { mode: 'fixed', scale: 1.75 };

  /** State as a previous session would have left it: one document, read at `zoom`. */
  const alreadyRead = (
    zoom: ZoomState,
    id = 'id-a',
    at = '2026-05-04T10:00:00.000Z',
  ): ReaderState =>
    rememberPosition(
      rememberOpen(emptyReaderState(), {
        id,
        path: `/books/${id}.pdf`,
        name: `${id}.pdf`,
        sizeBytes: 100,
        pageCount: 10,
        at,
      }),
      id,
      { page: 4, pageOffsetFraction: 0.5, zoom },
    );

  const zoomOf = (result: DocumentRequestResult): ZoomState | null | undefined =>
    result.status === 'opened' ? result.document.lastUsedZoom : undefined;

  it('reports the previous document, not the one being opened (startup path)', async () => {
    const { service, store } = harness({
      state: alreadyRead(ZOOMED),
      files: { '/books/b.pdf': opened('id-b', 'b.pdf') },
    });

    const result = await service.openPath('/books/b.pdf');

    expect(zoomOf(result)).toEqual(ZOOMED);
    // The open really was recorded first: this is the ordering that made
    // the defect possible, so the test would be worthless without it.
    expect(store.current().documents[0]?.id).toBe('id-b');
    expect(store.current().documents[0]?.position.zoom).toEqual(DEFAULT_ZOOM);
  });

  it('reports the zoom the reader left the open document at (in-application path)', async () => {
    const { service } = harness({
      files: {
        '/books/a.pdf': opened('id-a', 'a.pdf'),
        '/books/b.pdf': opened('id-b', 'b.pdf'),
      },
    });

    await service.openPath('/books/a.pdf');
    await service.savePosition({
      documentId: 'id-a',
      position: { page: 2, pageOffsetFraction: 0.5, zoom: ZOOMED },
      pageCount: 10,
    });

    expect(zoomOf(await service.openPath('/books/b.pdf'))).toEqual(ZOOMED);
  });

  it('reports it when the document is reopened from the recent list', async () => {
    const { service } = harness({
      state: alreadyRead(ZOOMED),
      files: {
        '/books/b.pdf': opened('id-b', 'b.pdf'),
        '/books/id-a.pdf': opened('id-a', 'id-a.pdf'),
      },
    });

    await service.openPath('/books/b.pdf');

    // Back to the first document, then out to the second one again: the
    // recent-list route goes through the same capture.
    const reopened = await service.openRecent('id-a');

    expect(zoomOf(reopened)).toEqual(DEFAULT_ZOOM);
    expect(reopened.status === 'opened' ? reopened.document.position?.zoom : null).toEqual(ZOOMED);
  });

  it('reports nothing when there is no earlier document', async () => {
    const { service } = harness({ files: { '/books/b.pdf': opened('id-b', 'b.pdf') } });

    expect(zoomOf(await service.openPath('/books/b.pdf'))).toBeNull();
  });

  it('reports the earlier document even when it was never zoomed', async () => {
    const { service } = harness({
      files: {
        '/books/a.pdf': opened('id-a', 'a.pdf'),
        '/books/b.pdf': opened('id-b', 'b.pdf'),
      },
    });

    await service.openPath('/books/a.pdf');

    expect(zoomOf(await service.openPath('/books/b.pdf'))).toEqual(DEFAULT_ZOOM);
  });

  it('reports a fit mode as faithfully as a scale', async () => {
    const { service } = harness({
      state: alreadyRead({ mode: 'fit-page', scale: 1 }),
      files: { '/books/b.pdf': opened('id-b', 'b.pdf') },
    });

    expect(zoomOf(await service.openPath('/books/b.pdf'))).toEqual({ mode: 'fit-page', scale: 1 });
  });

  it('never answers with the document being opened, even on reopening it', async () => {
    const { service } = harness({
      state: alreadyRead(ZOOMED),
      files: { '/books/id-a.pdf': opened('id-a', 'id-a.pdf') },
    });

    // The only document in the state is the one being opened, so there is
    // no earlier zoom — its own 1.75 must not be offered back as one.
    expect(zoomOf(await service.openPath('/books/id-a.pdf'))).toBeNull();
  });

  it('does not change what a remembered position restores to', async () => {
    const { service } = harness({
      state: alreadyRead(ZOOMED),
      files: { '/books/id-a.pdf': opened('id-a', 'id-a.pdf') },
    });

    const result = await service.openPath('/books/id-a.pdf');

    expect(result.status === 'opened' ? result.document.position : null).toEqual({
      page: 4,
      pageOffsetFraction: 0.5,
      zoom: ZOOMED,
    });
  });
});
