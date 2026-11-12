/** @vitest-environment jsdom */
import type { DesktopBridge, VocabularyBridge } from '@shared/ipc/contracts';
import type {
  LibraryIpcPage,
  LibraryIpcQuery,
  SearchIpcQuery,
  SearchIpcResults,
  VocabularyIpcResult,
} from '@shared/ipc/vocabularyContracts';
import type { SavedWord } from '@core/vocabulary/types';
import { act, renderHook, waitFor, type RenderHookResult } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { aSavedWord } from './libraryFixtures';
import { useVocabularyLibrary, type LibraryControls } from './useVocabularyLibrary';

/**
 * The library as state.
 *
 * These tests care about the promises the screen makes to a reader: that a
 * hidden library reads nothing, that paging never repeats or loses a row,
 * that a search says when it has been cut short, that removing is undoable
 * and that a failed removal puts the word back.
 */

interface Calls {
  readonly list: LibraryIpcQuery[];
  readonly search: SearchIpcQuery[];
  readonly removed: string[];
  readonly restored: string[];
}

interface Fake {
  readonly bridge: DesktopBridge;
  readonly calls: Calls;
}

const page = (
  items: readonly SavedWord[],
  nextCursor: LibraryIpcPage['nextCursor'] = null,
  unreadable = 0,
): LibraryIpcPage => ({
  items,
  nextCursor,
  unreadable,
  documents: [
    { documentId: 'doc-a', name: 'Meditations.pdf', available: true, count: items.length },
    { documentId: 'doc-b', name: 'Gone.pdf', available: false, count: 1 },
  ],
});

const results = (
  matches: readonly SavedWord[],
  definitionMatches: readonly SavedWord[] = [],
  truncated = false,
): SearchIpcResults => ({
  matches,
  definitionMatches,
  truncated,
  unreadable: 0,
  documents: [],
});

const fake = (
  overrides: Partial<{
    list: (query: LibraryIpcQuery) => Promise<VocabularyIpcResult<LibraryIpcPage>>;
    search: (query: SearchIpcQuery) => Promise<VocabularyIpcResult<SearchIpcResults>>;
    remove: (itemId: string) => Promise<VocabularyIpcResult<null>>;
    restore: (itemId: string) => Promise<VocabularyIpcResult<null>>;
  }> = {},
): Fake => {
  const calls: Calls = { list: [], search: [], removed: [], restored: [] };

  const vocabulary: VocabularyBridge = {
    stateForWord: vi.fn(),
    save: vi.fn(),
    occurrences: vi.fn(),
    exportLibrary: vi.fn(),
    list: async (query): Promise<VocabularyIpcResult<LibraryIpcPage>> => {
      calls.list.push(query);

      return overrides.list === undefined
        ? { ok: true, value: page([aSavedWord()]) }
        : overrides.list(query);
    },
    search: async (query): Promise<VocabularyIpcResult<SearchIpcResults>> => {
      calls.search.push(query);

      return overrides.search === undefined
        ? { ok: true, value: results([aSavedWord()]) }
        : overrides.search(query);
    },
    remove: async (itemId): Promise<VocabularyIpcResult<null>> => {
      calls.removed.push(itemId);

      return overrides.remove === undefined ? { ok: true, value: null } : overrides.remove(itemId);
    },
    restore: async (itemId): Promise<VocabularyIpcResult<null>> => {
      calls.restored.push(itemId);

      return overrides.restore === undefined
        ? { ok: true, value: null }
        : overrides.restore(itemId);
    },
  };

  return { bridge: { vocabulary } as unknown as DesktopBridge, calls };
};

const mount = (
  bridge: DesktopBridge | null,
  active = true,
): RenderHookResult<LibraryControls, unknown> =>
  renderHook(() => useVocabularyLibrary({ bridge, active }));

describe('the vocabulary library', () => {
  it('reads nothing while it is hidden', async () => {
    const { bridge, calls } = fake();

    mount(bridge, false);
    await act(async () => Promise.resolve());

    expect(calls.list).toHaveLength(0);
    expect(calls.search).toHaveLength(0);
  });

  it('lists the newest words first when it is opened', async () => {
    const { bridge, calls } = fake();
    const { result } = mount(bridge);

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });

    expect(calls.list[0]).toEqual({ sort: 'newest', documentId: null, cursor: null, limit: 50 });
    expect(result.current.state.items).toHaveLength(1);
    expect(result.current.state.documents).toHaveLength(2);
  });

  it('says it is loading before the answer arrives', async () => {
    const { bridge } = fake({
      list: (): Promise<VocabularyIpcResult<LibraryIpcPage>> =>
        new Promise(() => {
          // Never settles: the loading state is the subject here.
        }),
    });
    const { result } = mount(bridge);

    await waitFor(() => {
      expect(result.current.state.status).toBe('loading');
    });
    expect(result.current.state.items).toHaveLength(0);
  });

  it('distinguishes an empty library from a broken one', async () => {
    const empty = fake({
      list: (): Promise<VocabularyIpcResult<LibraryIpcPage>> =>
        Promise.resolve({
          ok: true,
          value: page([]),
        }),
    });
    const broken = fake({
      list: (): Promise<VocabularyIpcResult<LibraryIpcPage>> =>
        Promise.resolve({
          ok: false,
          error: { kind: 'unavailable', reason: 'corrupt' },
        }),
    });

    const first = mount(empty.bridge);

    await waitFor(() => {
      expect(first.result.current.state.status).toBe('ready');
    });
    expect(first.result.current.state.items).toHaveLength(0);
    expect(first.result.current.state.failure).toBeNull();

    const second = mount(broken.bridge);

    await waitFor(() => {
      expect(second.result.current.state.status).toBe('failed');
    });
    expect(second.result.current.state.failure).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
  });

  it('reports rows it could not read without hiding the rest', async () => {
    const { bridge } = fake({
      list: (): Promise<VocabularyIpcResult<LibraryIpcPage>> =>
        Promise.resolve({
          ok: true,
          value: page([aSavedWord()], null, 2),
        }),
    });
    const { result } = mount(bridge);

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });
    expect(result.current.state.unreadable).toBe(2);
    expect(result.current.state.items).toHaveLength(1);
  });

  it('pages with the cursor it was given and appends the next page', async () => {
    const { bridge, calls } = fake({
      list: (query): Promise<VocabularyIpcResult<LibraryIpcPage>> =>
        Promise.resolve(
          query.cursor === null
            ? {
                ok: true,
                value: page([aSavedWord({ id: 'one' })], { sortKey: '2026-03-01', id: 'one' }),
              }
            : { ok: true, value: page([aSavedWord({ id: 'two' })]) },
        ),
    });
    const { result } = mount(bridge);

    await waitFor(() => {
      expect(result.current.state.hasMore).toBe(true);
    });

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => {
      expect(result.current.state.items.map((item) => item.id)).toEqual(['one', 'two']);
    });
    expect(calls.list[1]?.cursor).toEqual({ sortKey: '2026-03-01', id: 'one' });
    expect(result.current.state.hasMore).toBe(false);
  });

  it('starts again from the beginning when the sort changes', async () => {
    const { bridge, calls } = fake({
      list: (): Promise<VocabularyIpcResult<LibraryIpcPage>> =>
        Promise.resolve({
          ok: true,
          value: page([aSavedWord()], { sortKey: 'k', id: 'one' }),
        }),
    });
    const { result } = mount(bridge);

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });

    act(() => {
      result.current.setSort('alphabetical');
    });

    await waitFor(() => {
      expect(calls.list).toHaveLength(2);
    });
    expect(calls.list[1]).toEqual({
      sort: 'alphabetical',
      documentId: null,
      cursor: null,
      limit: 50,
    });
  });

  it('filters by document', async () => {
    const { bridge, calls } = fake();
    const { result } = mount(bridge);

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });

    act(() => {
      result.current.setDocument('doc-b');
    });

    await waitFor(() => {
      expect(calls.list).toHaveLength(2);
    });
    expect(calls.list[1]?.documentId).toBe('doc-b');
  });

  it('searches instead of listing, and keeps word matches before definition matches', async () => {
    const { bridge, calls } = fake({
      search: (): Promise<VocabularyIpcResult<SearchIpcResults>> =>
        Promise.resolve({
          ok: true,
          value: results([aSavedWord({ id: 'word' })], [aSavedWord({ id: 'definition' })]),
        }),
    });
    const { result } = mount(bridge);

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });

    act(() => {
      result.current.setQuery('  equ  ');
    });

    await waitFor(() => {
      expect(result.current.state.items.map((item) => item.id)).toEqual(['word', 'definition']);
    });
    expect(calls.search[0]).toEqual({ query: 'equ', documentId: null, limit: 200 });
    expect(result.current.state.hasMore).toBe(false);
  });

  it('passes on the search cap rather than pretending the answer is whole', async () => {
    const { bridge } = fake({
      search: (): Promise<VocabularyIpcResult<SearchIpcResults>> =>
        Promise.resolve({
          ok: true,
          value: results([aSavedWord()], [], true),
        }),
    });
    const { result } = mount(bridge);

    act(() => {
      result.current.setQuery('e');
    });

    await waitFor(() => {
      expect(result.current.state.truncated).toBe(true);
    });
  });

  it('removes a word at once and offers to undo it', async () => {
    const { bridge, calls } = fake();
    const { result } = mount(bridge);

    await waitFor(() => {
      expect(result.current.state.items).toHaveLength(1);
    });

    const item = result.current.state.items[0];

    expect(item).toBeDefined();

    act(() => {
      result.current.remove(item as SavedWord);
    });

    expect(result.current.state.items).toHaveLength(0);
    expect(result.current.state.undo?.item.id).toBe('item-1');

    await waitFor(() => {
      expect(calls.removed).toEqual(['item-1']);
    });

    act(() => {
      result.current.undoRemove();
    });

    await waitFor(() => {
      expect(calls.restored).toEqual(['item-1']);
    });
    await waitFor(() => {
      expect(result.current.state.undo).toBeNull();
    });
  });

  it('puts the word back when the store refuses to remove it', async () => {
    const { bridge } = fake({
      remove: (): Promise<VocabularyIpcResult<null>> =>
        Promise.resolve({
          ok: false,
          error: { kind: 'write-failed' },
        }),
    });
    const { result } = mount(bridge);

    await waitFor(() => {
      expect(result.current.state.items).toHaveLength(1);
    });

    act(() => {
      result.current.remove(result.current.state.items[0] as SavedWord);
    });

    await waitFor(() => {
      expect(result.current.state.items).toHaveLength(1);
    });
    expect(result.current.state.undo).toBeNull();
    expect(result.current.state.failure).toEqual({ kind: 'write-failed' });
  });

  it('says so when a word cannot be put back', async () => {
    const { bridge } = fake({
      restore: (): Promise<VocabularyIpcResult<null>> =>
        Promise.resolve({
          ok: false,
          error: { kind: 'write-failed' },
        }),
    });
    const { result } = mount(bridge);

    await waitFor(() => {
      expect(result.current.state.items).toHaveLength(1);
    });

    act(() => {
      result.current.remove(result.current.state.items[0] as SavedWord);
    });
    act(() => {
      result.current.undoRemove();
    });

    await waitFor(() => {
      expect(result.current.state.undo?.failed).toBe(true);
    });
  });

  it('fails honestly when there is no bridge at all', async () => {
    const { result } = mount(null);

    await waitFor(() => {
      expect(result.current.state.status).toBe('failed');
    });
    expect(result.current.state.failure).toEqual({ kind: 'unavailable', reason: 'unknown' });
  });

  it('asks again when told to reload', async () => {
    const { bridge, calls } = fake();
    const { result } = mount(bridge);

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });

    act(() => {
      result.current.reload();
    });

    await waitFor(() => {
      expect(calls.list).toHaveLength(2);
    });
  });
});
