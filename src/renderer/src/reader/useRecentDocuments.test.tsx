/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EMPTY_READER_STATE_SNAPSHOT } from '@shared/ipc/contracts';
import type { DesktopBridge, ReaderStateSnapshot, RecentDocument } from '@shared/ipc/contracts';

import { useRecentDocuments } from './useRecentDocuments';
import { unconfiguredAiBridge } from '../testing/aiBridgeStub';
import { unavailableVocabularyBridge } from '../testing/vocabularyBridgeStub';

const recent = (id: string, available = true): RecentDocument => ({
  id,
  name: `${id}.pdf`,
  sizeBytes: 10,
  pageCount: 20,
  lastPage: 3,
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  available,
});

const snapshotOf = (...ids: readonly string[]): ReaderStateSnapshot => ({
  ...EMPTY_READER_STATE_SNAPSHOT,
  recents: ids.map((id) => recent(id)),
  lastDocumentId: ids[0] ?? null,
});

const createBridge = (overrides: Partial<DesktopBridge> = {}): DesktopBridge => ({
  getAppInfo: () =>
    Promise.resolve({ name: 't', version: '0', electronVersion: '0', chromeVersion: '0' }),
  openDocumentDialog: () => Promise.resolve({ status: 'none' }),
  getInitialDocument: () => Promise.resolve({ status: 'none' }),
  openRecentDocument: () => Promise.resolve({ status: 'none' }),
  getReaderState: () => Promise.resolve(snapshotOf('id-a', 'id-b')),
  saveReadingPosition: () => Promise.resolve('ok' as const),
  forgetDocument: () => Promise.resolve('ok' as const),
  savePreferences: () => Promise.resolve('ok' as const),
  lookUpWord: () =>
    Promise.resolve({ status: 'unavailable' as const, reason: 'not-installed' as const }),
  vocabulary: unavailableVocabularyBridge(),
  ai: unconfiguredAiBridge(),
  ...overrides,
});

/**
 * The bridge is a stable object in the application (it comes from the
 * preload script), so every test holds one instance rather than building a
 * new one on each render.
 */
describe('useRecentDocuments', () => {
  it('starts empty and then shows what the main process reports', async () => {
    const bridge = createBridge();
    const { result } = renderHook(() => useRecentDocuments(bridge));

    expect(result.current.snapshot.recents).toEqual([]);

    await waitFor(() => {
      expect(result.current.snapshot.recents.map((item) => item.id)).toEqual(['id-a', 'id-b']);
    });
    expect(result.current.snapshot.lastDocumentId).toBe('id-a');
  });

  it('stays empty, rather than failing, without a bridge', () => {
    const { result } = renderHook(() => useRecentDocuments(null));

    expect(result.current.snapshot).toEqual(EMPTY_READER_STATE_SNAPSHOT);
    expect(() => {
      result.current.forget('id-a');
      result.current.refresh();
    }).not.toThrow();
  });

  it('stays empty when the list cannot be read', async () => {
    const getReaderState = vi
      .fn<() => Promise<ReaderStateSnapshot>>()
      .mockRejectedValue(new Error('no state file'));
    const bridge = createBridge({ getReaderState });
    const { result } = renderHook(() => useRecentDocuments(bridge));

    await waitFor(() => {
      expect(getReaderState).toHaveBeenCalled();
    });

    expect(result.current.snapshot.recents).toEqual([]);
  });

  it('re-reads the list on request, picking up a newly opened document', async () => {
    const getReaderState = vi
      .fn<() => Promise<ReaderStateSnapshot>>()
      .mockResolvedValueOnce(snapshotOf('id-a'))
      .mockResolvedValue(snapshotOf('id-new', 'id-a'));
    const bridge = createBridge({ getReaderState });
    const { result } = renderHook(() => useRecentDocuments(bridge));

    await waitFor(() => {
      expect(result.current.snapshot.recents).toHaveLength(1);
    });

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.snapshot.recents.map((item) => item.id)).toEqual(['id-new', 'id-a']);
    });
  });

  it('removes an entry immediately and tells the main process to forget it', async () => {
    const forgetDocument = vi.fn(() => Promise.resolve('ok' as const));
    const bridge = createBridge({
      forgetDocument,
      getReaderState: () => Promise.resolve(snapshotOf('id-a', 'id-b')),
    });
    const { result } = renderHook(() => useRecentDocuments(bridge));

    await waitFor(() => {
      expect(result.current.snapshot.recents).toHaveLength(2);
    });

    act(() => {
      result.current.forget('id-a');
    });

    expect(result.current.snapshot.recents.map((item) => item.id)).toEqual(['id-b']);
    expect(result.current.snapshot.lastDocumentId).toBeNull();
    expect(forgetDocument).toHaveBeenCalledWith('id-a');
  });

  it('keeps an entry whose file is missing, marked unavailable', async () => {
    const bridge = createBridge({
      getReaderState: () =>
        Promise.resolve({
          ...EMPTY_READER_STATE_SNAPSHOT,
          recents: [recent('id-gone', false)],
          lastDocumentId: 'id-gone',
        }),
    });
    const { result } = renderHook(() => useRecentDocuments(bridge));

    await waitFor(() => {
      expect(result.current.snapshot.recents).toHaveLength(1);
    });

    expect(result.current.snapshot.recents[0]?.available).toBe(false);
  });

  it('ignores a snapshot that arrives after the reader has gone', () => {
    let resolveState: ((snapshot: ReaderStateSnapshot) => void) | null = null;
    const bridge = createBridge({
      getReaderState: () =>
        new Promise<ReaderStateSnapshot>((resolve) => {
          resolveState = resolve;
        }),
    });
    const { unmount } = renderHook(() => useRecentDocuments(bridge));

    unmount();

    expect(() => {
      resolveState?.(snapshotOf('id-a'));
    }).not.toThrow();
  });
});
