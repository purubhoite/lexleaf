import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  DocumentFilterOption,
  LibraryCursor,
  LibrarySort,
  SavedWord,
  VocabularyFailure,
} from '@core/vocabulary/types';
import type { DesktopBridge } from '@shared/ipc/contracts';
import type {
  LibraryIpcPage,
  SearchIpcResults,
  VocabularyIpcResult,
} from '@shared/ipc/vocabularyContracts';

/**
 * The library, as a piece of state.
 *
 * A screen that lists a reader's own work has to be honest about four
 * things, and they are the four states below: it is loading, it is empty,
 * it could not be read, or here are the words. "Empty" and "broken" are
 * different answers and must never be shown as the same one.
 *
 * Paging is by cursor, not by page number: the reader can save a word
 * while the library is open, and a keyset cursor means that cannot make a
 * row appear twice or vanish.
 */

export type LibraryStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface UndoState {
  readonly item: SavedWord;
  readonly failed: boolean;
}

export interface LibraryState {
  readonly status: LibraryStatus;
  readonly items: readonly SavedWord[];
  readonly documents: readonly DocumentFilterOption[];
  readonly sort: LibrarySort;
  readonly documentId: string | null;
  readonly query: string;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  /** True when a search hit the 200-row cap. */
  readonly truncated: boolean;
  /** Rows the store could not read. They are counted, never deleted. */
  readonly unreadable: number;
  readonly failure: VocabularyFailure | null;
  readonly undo: UndoState | null;
  /** Bumped by `reload`, so asking again is a new request. */
  readonly nonce: number;
}

export interface LibraryControls {
  readonly state: LibraryState;
  readonly setSort: (sort: LibrarySort) => void;
  readonly setDocument: (documentId: string | null) => void;
  readonly setQuery: (query: string) => void;
  readonly loadMore: () => void;
  readonly reload: () => void;
  readonly remove: (item: SavedWord) => void;
  readonly undoRemove: () => void;
  readonly dismissUndo: () => void;
}

const EMPTY: LibraryState = {
  status: 'idle',
  items: [],
  documents: [],
  sort: 'newest',
  documentId: null,
  query: '',
  hasMore: false,
  loadingMore: false,
  truncated: false,
  unreadable: 0,
  failure: null,
  undo: null,
  nonce: 0,
};

export interface LibraryOptions {
  readonly bridge: DesktopBridge | null;
  /** False while the library is hidden, so it does not open the database. */
  readonly active: boolean;
}

export const useVocabularyLibrary = ({ bridge, active }: LibraryOptions): LibraryControls => {
  const [state, setState] = useState<LibraryState>(EMPTY);
  const cursor = useRef<LibraryCursor | null>(null);
  const token = useRef(0);
  const vocabulary = bridge?.vocabulary ?? null;

  const { sort, documentId, query } = state;

  const load = useCallback(
    (append: boolean): void => {
      // No bridge means no store; the render below has already said so.
      if (vocabulary === null) {
        return;
      }

      // A fresh request starts at the beginning of the list.
      if (!append) {
        cursor.current = null;
      }

      token.current += 1;
      const issued = token.current;

      const trimmed = query.trim();
      const request: Promise<VocabularyIpcResult<LibraryIpcPage | SearchIpcResults>> =
        trimmed.length === 0
          ? vocabulary.list({ sort, documentId, cursor: append ? cursor.current : null, limit: 50 })
          : vocabulary.search({ query: trimmed, documentId, limit: 200 });

      void request
        .then((reply) => {
          if (token.current !== issued) {
            return;
          }

          if (!reply.ok) {
            setState((current) => ({
              ...current,
              status: 'failed',
              loadingMore: false,
              failure: reply.error,
            }));

            return;
          }

          const answer = reply.value;

          if ('items' in answer) {
            cursor.current = answer.nextCursor;

            setState((current) => ({
              ...current,
              status: 'ready',
              loadingMore: false,
              items: append ? [...current.items, ...answer.items] : answer.items,
              documents: answer.documents,
              hasMore: answer.nextCursor !== null,
              truncated: false,
              unreadable: answer.unreadable,
              failure: null,
            }));

            return;
          }

          // A search is answered whole: there is nothing to page through,
          // and the cap is reported rather than hidden.
          cursor.current = null;

          setState((current) => ({
            ...current,
            status: 'ready',
            loadingMore: false,
            items: [...answer.matches, ...answer.definitionMatches],
            documents: answer.documents,
            hasMore: false,
            truncated: answer.truncated,
            unreadable: answer.unreadable,
            failure: null,
          }));
        })
        .catch(() => {
          if (token.current === issued) {
            setState((current) => ({
              ...current,
              status: 'failed',
              loadingMore: false,
              failure: { kind: 'unavailable', reason: 'unknown' },
            }));
          }
        });
    },
    [documentId, query, sort, vocabulary],
  );

  /**
   * What is being asked for.
   *
   * Sort, filter, query and an explicit reload make up the request; when
   * it changes the list is marked as loading during render, so the effect
   * below only has to issue the call. The library is only read while the
   * reader is looking at it: a hidden library must not open a database on
   * their behalf.
   */
  const requestKey = active
    ? `${sort}\u0000${documentId ?? ''}\u0000${query.trim()}\u0000${String(state.nonce)}`
    : null;
  // `undefined` means "nothing has been asked for yet", so the first
  // render of an open library marks itself as loading rather than idle.
  const [lastRequestKey, setLastRequestKey] = useState<string | null | undefined>(undefined);

  if (requestKey !== lastRequestKey) {
    setLastRequestKey(requestKey);

    if (requestKey !== null) {
      setState((current) =>
        vocabulary === null
          ? {
              ...current,
              status: 'failed',
              loadingMore: false,
              failure: { kind: 'unavailable', reason: 'unknown' },
            }
          : { ...current, status: 'loading', loadingMore: false, failure: null },
      );
    }
  }

  useEffect(() => {
    if (requestKey === null) {
      return;
    }

    load(false);
    // `load` closes over exactly the parts of the request key, so the key
    // is the honest dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const setSort = useCallback((next: LibrarySort): void => {
    cursor.current = null;
    setState((current) => ({ ...current, sort: next }));
  }, []);

  const setDocument = useCallback((next: string | null): void => {
    cursor.current = null;
    setState((current) => ({ ...current, documentId: next }));
  }, []);

  const setQuery = useCallback((next: string): void => {
    cursor.current = null;
    setState((current) => ({ ...current, query: next }));
  }, []);

  const loadMore = useCallback((): void => {
    if (state.hasMore && !state.loadingMore) {
      setState((current) => ({ ...current, loadingMore: true }));
      load(true);
    }
  }, [load, state.hasMore, state.loadingMore]);

  const reload = useCallback((): void => {
    setState((current) => ({ ...current, nonce: current.nonce + 1 }));
  }, []);

  /**
   * Removing a word takes it off the list at once.
   *
   * The row disappears immediately because that is what the reader asked
   * for, and the item is held for undo. If the store refuses, the word
   * comes back and says why — an entry must not vanish because a write
   * failed.
   */
  const remove = useCallback(
    (item: SavedWord): void => {
      if (vocabulary === null) {
        return;
      }

      setState((current) => ({
        ...current,
        items: current.items.filter((candidate) => candidate.id !== item.id),
        undo: { item, failed: false },
      }));

      void vocabulary
        .remove(item.id)
        .then((reply) => {
          if (!reply.ok) {
            setState((current) => ({
              ...current,
              items: [item, ...current.items],
              undo: null,
              failure: reply.error,
            }));
          }
        })
        .catch(() => {
          setState((current) => ({
            ...current,
            items: [item, ...current.items],
            undo: null,
          }));
        });
    },
    [vocabulary],
  );

  const undoRemove = useCallback((): void => {
    const pending = state.undo;

    if (vocabulary === null || pending === null) {
      return;
    }

    void vocabulary
      .restore(pending.item.id)
      .then((reply) => {
        if (!reply.ok) {
          setState((current) => ({
            ...current,
            undo: current.undo === null ? null : { ...current.undo, failed: true },
          }));

          return;
        }

        setState((current) => ({ ...current, undo: null, nonce: current.nonce + 1 }));
      })
      .catch(() => {
        setState((current) => ({
          ...current,
          undo: current.undo === null ? null : { ...current.undo, failed: true },
        }));
      });
  }, [state.undo, vocabulary]);

  const dismissUndo = useCallback((): void => {
    setState((current) => ({ ...current, undo: null }));
  }, []);

  return {
    state,
    setSort,
    setDocument,
    setQuery,
    loadMore,
    reload,
    remove,
    undoRemove,
    dismissUndo,
  };
};
