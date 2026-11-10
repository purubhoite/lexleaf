import type { Preferences } from '@core/persistence/preferences';
import {
  findDocument,
  forgetDocument,
  lastOpenedDocument,
  lastUsedZoom,
  rememberOpen,
  rememberPosition,
  rememberPreferences,
} from '@core/persistence/readerState';
import type {
  DocumentRequestResult,
  ReaderStateSnapshot,
  ReadingPositionUpdate,
  RecentDocument,
  SessionRecovery,
  StateWriteHealth,
} from '@shared/ipc/contracts';

import { displayName } from '../documents/documentFile';
import type { ReaderStateStore } from '../persistence/readerStateStore';

/**
 * Everything the main process does with reading state.
 *
 * It is the join between "a path on disk" and "a document the reader knows
 * about": the renderer asks for a document by id, this service turns the id
 * into a path, reads the file, and attaches the remembered position to the
 * payload. No path ever travels in the other direction (ADR-016).
 *
 * Every dependency is injected, so the whole service — including the rule
 * that a recent entry pointing at a deleted file is removed — is tested
 * without a disk, a dialog or Electron.
 */

export interface ReaderStateServiceOptions {
  readonly store: ReaderStateStore;
  /** Reads a document from a path, applying the size and type rules. */
  readonly readDocument: (path: string) => Promise<DocumentRequestResult>;
  /** True when the file behind a recent entry is still there. */
  readonly exists: (path: string) => Promise<boolean>;
  readonly now: () => Date;
  /**
   * How the renderer asking for this snapshot came to exist (M7.1).
   *
   * Injected rather than stored: it is a fact about the running process,
   * not about the reader's state, and nothing writes it to disk. Absent
   * means `none`, so every existing caller keeps its behaviour.
   */
  readonly sessionRecovery?: () => SessionRecovery;
}

/**
 * What the main process knows about a document it has opened.
 *
 * Main-process only, and never sent to a renderer: it carries the path.
 * The vocabulary store copies these facts the first time a word is saved
 * from a document and keeps its own copy afterwards, so a document that
 * later falls off the capped recent list does not take a reader's saved
 * words with it.
 */
export interface KnownDocument {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly pageCount: number | null;
  readonly sizeBytes: number;
}

export interface ReaderStateService {
  /** Recent documents, with availability checked, and the last one opened. */
  snapshot(): Promise<ReaderStateSnapshot>;
  /** Main-process facts about a document this application has opened. */
  describe(documentId: string): Promise<KnownDocument | null>;
  /** Opens a path the user chose and records the open. */
  openPath(path: string): Promise<DocumentRequestResult>;
  /** Opens a document that has been read before, by id. */
  openRecent(documentId: string): Promise<DocumentRequestResult>;
  /**
   * Records a position and reports whether reading state is reaching the
   * disk. The health describes the store's last *completed* write, not
   * this call: writes are coalesced, so this one has not happened yet
   * (M7.2, ADR-034).
   */
  savePosition(update: ReadingPositionUpdate): Promise<StateWriteHealth>;
  forget(documentId: string): Promise<StateWriteHealth>;
  /** The four settings as stored, or the defaults (ADR-031). */
  preferences(): Promise<Preferences>;
  /** Stores the four settings. Nothing else in the document is touched. */
  savePreferences(preferences: Preferences): Promise<StateWriteHealth>;
  /**
   * Writes anything pending; called before the application quits.
   *
   * Returns the store's health *after* the attempt (M7.3, C-2). A write
   * that fails is diagnosed rather than thrown, so a caller that needs to
   * know whether the last state reached the disk — the quit flush, which
   * must not report success it did not have — has to be told.
   */
  flush(): Promise<StateWriteHealth>;
}

export const createReaderStateService = ({
  store,
  readDocument,
  exists,
  now,
  sessionRecovery = (): SessionRecovery => 'none',
}: ReaderStateServiceOptions): ReaderStateService => {
  const service: ReaderStateService = {
    async snapshot(): Promise<ReaderStateSnapshot> {
      const state = await store.load();

      const recents: RecentDocument[] = await Promise.all(
        state.documents.map(async (document) => ({
          id: document.id,
          name: document.name,
          sizeBytes: document.sizeBytes,
          pageCount: document.pageCount,
          lastPage: document.position.page,
          lastOpenedAt: document.lastOpenedAt,
          available: await exists(document.path),
        })),
      );

      return {
        recents,
        lastDocumentId: lastOpenedDocument(state)?.id ?? null,
        preferences: state.preferences,
        sessionRecovery: sessionRecovery(),
      };
    },

    async describe(documentId: string): Promise<KnownDocument | null> {
      const state = await store.load();
      const record = findDocument(state, documentId);

      return record === null
        ? null
        : {
            id: record.id,
            name: record.name,
            path: record.path,
            pageCount: record.pageCount,
            sizeBytes: record.sizeBytes,
          };
    },

    async openPath(path: string): Promise<DocumentRequestResult> {
      const result = await readDocument(path);

      if (result.status !== 'opened') {
        return result;
      }

      const state = await store.load();
      const known = findDocument(state, result.document.id);

      /*
       * What `defaultZoomMode: 'last-used'` means, decided here and sent
       * with the open (ADR-031, 6.8 closure audit).
       *
       * It is read from the state as it stands *before* `rememberOpen`
       * writes this document into it, and with this document excluded in
       * any case, so the answer is the zoom of the document the reader
       * was reading before — never this one's freshly initialised
       * position, and never a value that depends on when the renderer
       * last happened to ask for a snapshot.
       */
      const previousZoom = lastUsedZoom(state, result.document.id);

      store.update((previous) =>
        rememberOpen(previous, {
          id: result.document.id,
          path,
          name: result.document.name,
          sizeBytes: result.document.sizeBytes,
          pageCount: known?.pageCount ?? null,
          at: now().toISOString(),
        }),
      );

      return {
        status: 'opened',
        document: {
          ...result.document,
          position: known?.position ?? null,
          lastUsedZoom: previousZoom,
        },
      };
    },

    async openRecent(documentId: string): Promise<DocumentRequestResult> {
      const state = await store.load();
      const record = findDocument(state, documentId);

      if (record === null) {
        /*
         * The id is well formed but names nothing this application has
         * read. From the reader's side that is the same situation as a
         * file that is gone — and it is reported with the same word, so
         * the vocabulary stays closed and small (M7.2).
         */
        return { status: 'unreadable', reason: 'missing', name: null };
      }

      const result = await service.openPath(record.path);

      if (result.status === 'unreadable') {
        // The entry cannot be used again, so it stops being offered. This is
        // the only place a recent entry is removed automatically.
        store.update((previous) => forgetDocument(previous, documentId));

        /*
         * The reason comes from the attempt, so a recent entry whose file
         * has become unreadable no longer claims it was deleted. The name
         * comes from the recent entry rather than from the attempt,
         * because that is the name this list has been showing the reader:
         * it is the record's own stored name, never its path.
         */
        return { ...result, name: displayName(record.name) };
      }

      return result;
    },

    async savePosition(update: ReadingPositionUpdate): Promise<StateWriteHealth> {
      await store.load();
      store.update((previous) =>
        rememberPosition(previous, update.documentId, update.position, update.pageCount),
      );

      return store.writeHealth();
    },

    async forget(documentId: string): Promise<StateWriteHealth> {
      await store.load();
      store.update((previous) => forgetDocument(previous, documentId));

      return store.writeHealth();
    },

    async preferences(): Promise<Preferences> {
      const state = await store.load();

      return state.preferences;
    },

    /*
     * Loaded before it is written, like every other change: writing into a
     * store that has not read the file yet would replace a reader's recent
     * list with an empty one on the first preference they ever change.
     */
    async savePreferences(preferences: Preferences): Promise<StateWriteHealth> {
      await store.load();
      store.update((previous) => rememberPreferences(previous, preferences));

      return store.writeHealth();
    },

    flush: async (): Promise<StateWriteHealth> => {
      await store.flush();

      return store.writeHealth();
    },
  };

  return service;
};
