/** @vitest-environment jsdom */
import { EMPTY_ANNOTATIONS, type DocumentAnnotations } from '@core/annotations/annotations';
import type { AnnotationsBridge, DesktopBridge } from '@shared/ipc/contracts';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAnnotations } from './useAnnotations';

const stored: DocumentAnnotations = {
  highlights: [],
  bookmarks: [{ page: 3, label: 'Three', createdAt: '2026-01-01T00:00:00.000Z' }],
  rotation: 90,
};

const makeBridge = (
  overrides: Partial<AnnotationsBridge> = {},
): { bridge: DesktopBridge; annotations: AnnotationsBridge } => {
  const annotations: AnnotationsBridge = {
    load: vi.fn(() => Promise.resolve(stored)),
    save: vi.fn(() => Promise.resolve(true)),
    exportDocument: vi.fn(() => Promise.resolve({ status: 'exported' as const, count: 1 })),
    ...overrides,
  };

  return { bridge: { annotations } as unknown as DesktopBridge, annotations };
};

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a book's highlights, notes and bookmarks", () => {
  it('reads what was kept for the book that is open', async () => {
    const { bridge, annotations } = makeBridge();
    const { result } = renderHook(() => useAnnotations(bridge, 'doc-a', 'A.pdf'));

    expect(result.current.annotations).toBe(EMPTY_ANNOTATIONS);

    await settle();

    expect(annotations.load).toHaveBeenCalledWith('doc-a');
    expect(result.current.annotations).toStrictEqual(stored);
  });

  it('writes a change a moment later, once, however many there were', async () => {
    const { bridge, annotations } = makeBridge();
    const { result } = renderHook(() => useAnnotations(bridge, 'doc-a', 'A.pdf'));
    await settle();

    let id: string | null = null;

    act(() => {
      id = result.current.highlight([{ page: 1, start: 0, end: 5, text: 'hello' }], 'yellow');
    });
    act(() => {
      result.current.setNote(id ?? '', 'n');
    });
    act(() => {
      result.current.setNote(id ?? '', 'note');
    });

    expect(annotations.save).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(annotations.save).toHaveBeenCalledOnce();

    const [documentId, name, written] = vi.mocked(annotations.save).mock.calls[0] ?? [];

    expect(documentId).toBe('doc-a');
    expect(name).toBe('A.pdf');
    expect(written?.highlights[0]).toMatchObject({ text: 'hello', colour: 'yellow', note: 'note' });
  });

  it('recolours, removes, bookmarks and turns the pages', async () => {
    const { bridge } = makeBridge();
    const { result } = renderHook(() => useAnnotations(bridge, 'doc-a', 'A.pdf'));
    await settle();

    let id: string | null = null;

    act(() => {
      id = result.current.highlight([{ page: 1, start: 0, end: 5, text: 'hello' }], 'yellow');
    });
    act(() => {
      result.current.recolour(id ?? '', 'pink');
    });
    expect(result.current.annotations.highlights[0]?.colour).toBe('pink');

    act(() => {
      result.current.remove(id ?? '');
    });
    expect(result.current.annotations.highlights).toHaveLength(0);

    act(() => {
      result.current.toggleBookmark(3, '');
    });
    expect(result.current.annotations.bookmarks).toHaveLength(0);

    act(() => {
      result.current.rotate(1);
    });
    expect(result.current.annotations.rotation).toBe(180);
  });

  it('writes what is waiting, for the right book, when the book changes', async () => {
    const { bridge, annotations } = makeBridge();
    const { result, rerender } = renderHook(({ id }) => useAnnotations(bridge, id, `${id}.pdf`), {
      initialProps: { id: 'doc-a' },
    });
    await settle();

    act(() => {
      result.current.rotate(1);
    });
    rerender({ id: 'doc-b' });

    expect(annotations.save).toHaveBeenCalledOnce();
    expect(vi.mocked(annotations.save).mock.calls[0]?.[0]).toBe('doc-a');

    // The first book's set is never shown for the second.
    expect(result.current.annotations).toBe(EMPTY_ANNOTATIONS);
  });

  it('says so when a change could not be written, and keeps the change', async () => {
    const { bridge } = makeBridge({ save: vi.fn(() => Promise.resolve(false)) });
    const { result } = renderHook(() => useAnnotations(bridge, 'doc-a', 'A.pdf'));
    await settle();

    act(() => {
      result.current.rotate(1);
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    await settle();

    expect(result.current.writeFailed).toBe(true);
    expect(result.current.annotations.rotation).toBe(180);
  });

  it('writes what was just typed before exporting', async () => {
    const order: string[] = [];
    const { bridge } = makeBridge({
      save: vi.fn(() => {
        order.push('save');

        return Promise.resolve(true);
      }),
      exportDocument: vi.fn(() => {
        order.push('export');

        return Promise.resolve({ status: 'exported' as const, count: 1 });
      }),
    });
    const { result } = renderHook(() => useAnnotations(bridge, 'doc-a', 'A.pdf'));
    await settle();

    act(() => {
      result.current.rotate(1);
    });
    await act(async () => {
      await result.current.exportDocument?.();
    });

    expect(order).toStrictEqual(['save', 'export']);
  });

  it('works for this session with nowhere to keep anything', () => {
    const { result } = renderHook(() => useAnnotations(null, 'doc-a', 'A.pdf'));

    act(() => {
      result.current.toggleBookmark(2, 'Two');
    });

    expect(result.current.annotations.bookmarks).toHaveLength(1);
    expect(result.current.exportDocument).toBeUndefined();
  });
});
