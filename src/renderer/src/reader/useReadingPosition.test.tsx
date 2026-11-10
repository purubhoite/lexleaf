/**
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReadingPosition } from '@core/persistence/types';
import { EMPTY_READER_STATE_SNAPSHOT } from '@shared/ipc/contracts';
import type { DesktopBridge, ReadingPositionUpdate, StateWriteHealth } from '@shared/ipc/contracts';

import { useReadingPosition } from './useReadingPosition';
import { unconfiguredAiBridge } from '../testing/aiBridgeStub';
import { unavailableVocabularyBridge } from '../testing/vocabularyBridgeStub';

const position = (page: number): ReadingPosition => ({
  page,
  pageOffsetFraction: 0.25,
  zoom: { mode: 'fit-width', scale: 1 },
});

interface Recorder {
  readonly bridge: DesktopBridge;
  readonly saved: ReadingPositionUpdate[];
}

const createBridge = (failing = false, health: StateWriteHealth = 'ok'): Recorder => {
  const saved: ReadingPositionUpdate[] = [];

  return {
    saved,
    bridge: {
      getAppInfo: () =>
        Promise.resolve({ name: 't', version: '0', electronVersion: '0', chromeVersion: '0' }),
      openDocumentDialog: () => Promise.resolve({ status: 'none' }),
      getInitialDocument: () => Promise.resolve({ status: 'none' }),
      openRecentDocument: () => Promise.resolve({ status: 'none' }),
      getReaderState: () => Promise.resolve(EMPTY_READER_STATE_SNAPSHOT),
      saveReadingPosition: (update): Promise<StateWriteHealth> => {
        if (failing) {
          return Promise.reject(new Error('disk full'));
        }

        saved.push(update);

        return Promise.resolve(health);
      },
      forgetDocument: () => Promise.resolve('ok' as const),
      savePreferences: () => Promise.resolve('ok' as const),
      lookUpWord: () =>
        Promise.resolve({ status: 'unavailable' as const, reason: 'not-installed' as const }),
      vocabulary: unavailableVocabularyBridge(),
      ai: unconfiguredAiBridge(),
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useReadingPosition', () => {
  it('coalesces a burst of scrolling into one save', () => {
    const { bridge, saved } = createBridge();
    const { result } = renderHook(() => useReadingPosition(bridge, 'id-a', 100));

    act(() => {
      for (let page = 1; page <= 30; page += 1) {
        result.current.record(position(page));
      }
    });

    expect(saved).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(saved).toEqual([{ documentId: 'id-a', position: position(30), pageCount: 100 }]);
  });

  it('sends nothing when nothing was recorded', () => {
    const { bridge, saved } = createBridge();

    renderHook(() => useReadingPosition(bridge, 'id-a', 10));

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(saved).toEqual([]);
  });

  it('flushes on demand without waiting', () => {
    const { bridge, saved } = createBridge();
    const { result } = renderHook(() => useReadingPosition(bridge, 'id-a', 10));

    act(() => {
      result.current.record(position(4));
      void result.current.flush();
    });

    expect(saved).toHaveLength(1);

    // The pending timer was cancelled, so the position is not sent twice.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(saved).toHaveLength(1);
  });

  it('resolves the flush only once the main process has stored the position', async () => {
    // The recent list is read back as soon as a document is left, so a flush
    // that resolved early would hand back the previous page number.
    const saved: ReadingPositionUpdate[] = [];
    const gate: { release: (() => void) | null } = { release: null };
    const bridge = {
      ...createBridge().bridge,
      saveReadingPosition: (update: ReadingPositionUpdate): Promise<StateWriteHealth> =>
        new Promise<StateWriteHealth>((resolve) => {
          gate.release = (): void => {
            saved.push(update);
            resolve('ok');
          };
        }),
    } satisfies DesktopBridge;
    const { result } = renderHook(() => useReadingPosition(bridge, 'id-a', 10));

    let settled = false;

    act(() => {
      result.current.record(position(7));
    });

    const flushed = result.current.flush().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    gate.release?.();
    await flushed;

    expect(settled).toBe(true);
    expect(saved).toEqual([{ documentId: 'id-a', position: position(7), pageCount: 10 }]);
  });

  it('waits for a save already in flight even when nothing new is pending', async () => {
    const order: string[] = [];
    const gate: { release: (() => void) | null } = { release: null };
    const bridge = {
      ...createBridge().bridge,
      saveReadingPosition: (): Promise<StateWriteHealth> =>
        new Promise<StateWriteHealth>((resolve) => {
          gate.release = (): void => {
            order.push('stored');
            resolve('ok');
          };
        }),
    } satisfies DesktopBridge;
    const { result } = renderHook(() => useReadingPosition(bridge, 'id-a', 10));

    act(() => {
      result.current.record(position(3));
      vi.advanceTimersByTime(600);
    });

    // Nothing is pending now, but the earlier write has not landed.
    const flushed = result.current.flush().then(() => order.push('flush resolved'));

    gate.release?.();
    await flushed;

    expect(order).toEqual(['stored', 'flush resolved']);
  });

  it('flushes the position of the document being left, not the new one', () => {
    const { bridge, saved } = createBridge();
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useReadingPosition(bridge, id, 10),
      { initialProps: { id: 'id-a' } },
    );

    act(() => {
      result.current.record(position(8));
    });

    rerender({ id: 'id-b' });

    expect(saved).toEqual([{ documentId: 'id-a', position: position(8), pageCount: 10 }]);
  });

  it('flushes when the window goes away', () => {
    const { bridge, saved } = createBridge();
    const { result } = renderHook(() => useReadingPosition(bridge, 'id-a', 10));

    act(() => {
      result.current.record(position(12));
    });

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(saved).toEqual([{ documentId: 'id-a', position: position(12), pageCount: 10 }]);
  });

  it('flushes when the reader is unmounted', () => {
    const { bridge, saved } = createBridge();
    const { result, unmount } = renderHook(() => useReadingPosition(bridge, 'id-a', 10));

    act(() => {
      result.current.record(position(3));
    });

    unmount();

    expect(saved).toHaveLength(1);
  });

  it('records nothing when no document is open', () => {
    const { bridge, saved } = createBridge();
    const { result } = renderHook(() => useReadingPosition(bridge, null, null));

    act(() => {
      result.current.record(position(1));
      void result.current.flush();
    });

    expect(saved).toEqual([]);
  });

  it('does nothing at all without a desktop bridge', () => {
    const { result } = renderHook(() => useReadingPosition(null, 'id-a', 10));

    expect(() => {
      act(() => {
        result.current.record(position(1));
        void result.current.flush();
      });
    }).not.toThrow();
  });

  it('swallows a failure to save, because losing a bookmark must not interrupt reading', () => {
    const { bridge } = createBridge(true);
    const { result } = renderHook(() => useReadingPosition(bridge, 'id-a', 10));

    expect(() => {
      act(() => {
        result.current.record(position(5));
        void result.current.flush();
      });
    }).not.toThrow();
  });

  /* ---------------------------------------------------------------- *
   * M7.2: a save that did not reach the disk says so
   * ---------------------------------------------------------------- */

  it('passes on the health of the write, so the shell can tell the reader', async () => {
    const { bridge } = createBridge(false, 'failing');
    const reported: string[] = [];
    const { result } = renderHook(() =>
      useReadingPosition(bridge, 'id-a', 10, (health) => reported.push(health)),
    );

    await act(async () => {
      result.current.record(position(3));
      await result.current.flush();
    });

    expect(reported).toEqual(['failing']);
  });

  it('reports a healthy write as healthy', async () => {
    const { bridge } = createBridge();
    const reported: string[] = [];
    const { result } = renderHook(() =>
      useReadingPosition(bridge, 'id-a', 10, (health) => reported.push(health)),
    );

    await act(async () => {
      result.current.record(position(3));
      await result.current.flush();
    });

    expect(reported).toEqual(['ok']);
  });

  it('reports nothing at all when the save itself rejects', async () => {
    // A rejected call is a broken bridge, not a failing disk. Reporting
    // `failing` here would tell the reader their state is not being saved
    // on the strength of a different fault entirely.
    const { bridge } = createBridge(true);
    const reported: string[] = [];
    const { result } = renderHook(() =>
      useReadingPosition(bridge, 'id-a', 10, (health) => reported.push(health)),
    );

    await act(async () => {
      result.current.record(position(3));
      await result.current.flush();
    });

    expect(reported).toEqual([]);
  });

  it('does not rebuild the recorder when the caller passes a new function each render', () => {
    const { bridge } = createBridge();
    const { result, rerender } = renderHook(() =>
      useReadingPosition(bridge, 'id-a', 10, () => undefined),
    );
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });

  it('reports an unknown page count rather than inventing one', () => {
    const { bridge, saved } = createBridge();
    const { result } = renderHook(() => useReadingPosition(bridge, 'id-a', null));

    act(() => {
      result.current.record(position(2));
      void result.current.flush();
    });

    expect(saved[0]?.pageCount).toBeNull();
  });
});
