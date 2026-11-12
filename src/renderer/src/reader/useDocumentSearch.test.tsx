/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { OpenedPdf } from '@core/pdf/pdfEngine';
import type { PdfPageText } from '@core/pdf/types';
import type { TextSegment } from '@core/word/types';

import { useDocumentSearch, MAX_MATCHES } from './useDocumentSearch';

/**
 * Search runs over engine text, so it covers pages that have never been
 * rendered; these tests therefore never mount a page.
 */

const segments = (text: string): readonly TextSegment[] => [{ text, endsLine: false }];

const documentOf = (
  pages: readonly string[],
  options: { readonly onPage?: (pageNumber: number) => void } = {},
): OpenedPdf => ({
  pageCount: pages.length,
  label: 'fake.pdf',
  getPageText: (pageNumber: number): Promise<PdfPageText> => {
    options.onPage?.(pageNumber);

    return Promise.resolve({
      pageNumber,
      segments: segments(pages[pageNumber - 1] ?? ''),
      hasTextLayer: true,
    });
  },
  getPageSize: () => Promise.resolve({ width: 600, height: 800, rotation: 0 }),
  getOutline: () => Promise.resolve([]),
  getNativePage: () => Promise.resolve({}),
  close: () => Promise.resolve(),
});

const PAGES = [
  'the harbour was quiet',
  'a Harbour light blinked',
  'nothing of interest here',
  'the harbour again, and harbour once more',
];

/**
 * A document is identified by reference, so every test holds one instance
 * for the lifetime of the hook — exactly as the reader does.
 */
const renderSearch = (
  document: OpenedPdf | null,
  pageCount = document?.pageCount ?? 0,
): ReturnType<typeof renderHook<ReturnType<typeof useDocumentSearch>, unknown>> =>
  renderHook(() => useDocumentSearch(document, pageCount));

describe('useDocumentSearch', () => {
  it('is idle before anything is searched for', () => {
    const { result } = renderSearch(documentOf(PAGES));

    expect(result.current.state).toMatchObject({
      status: 'idle',
      matches: [],
      currentIndex: null,
      totalPages: 4,
    });
  });

  it('finds every occurrence across pages, ignoring case by default', async () => {
    const { result } = renderSearch(documentOf(PAGES));

    act(() => {
      result.current.run({ text: 'harbour', caseSensitive: false }, 1);
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('complete');
    });

    expect(result.current.state.matches).toHaveLength(4);
    expect(result.current.state.matches.map((match) => match.pageNumber)).toEqual([1, 2, 4, 4]);
    expect(result.current.state.currentIndex).toBe(0);
    expect(result.current.state.scannedPages).toBe(4);
  });

  it('respects a case-sensitive query', async () => {
    const { result } = renderSearch(documentOf(PAGES));

    act(() => {
      result.current.run({ text: 'Harbour', caseSensitive: true }, 1);
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('complete');
    });

    expect(result.current.state.matches.map((match) => match.pageNumber)).toEqual([2]);
  });

  it('reports no matches without pretending to be idle', async () => {
    const { result } = renderSearch(documentOf(PAGES));

    act(() => {
      result.current.run({ text: 'submarine', caseSensitive: false }, 1);
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('complete');
    });

    expect(result.current.state.matches).toEqual([]);
    expect(result.current.state.currentIndex).toBeNull();
  });

  it('does not run an empty query', async () => {
    const onPage = vi.fn();
    const { result } = renderSearch(documentOf(PAGES, { onPage }));

    act(() => {
      result.current.run({ text: '   ', caseSensitive: false }, 1);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe('idle');
    expect(onPage).not.toHaveBeenCalled();
  });

  it('starts scanning at the reader’s page and wraps around', async () => {
    const visited: number[] = [];
    const { result } = renderSearch(
      documentOf(PAGES, {
        onPage: (pageNumber) => {
          visited.push(pageNumber);
        },
      }),
    );

    act(() => {
      result.current.run({ text: 'harbour', caseSensitive: false }, 3);
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('complete');
    });

    expect(visited).toEqual([3, 4, 1, 2]);
    // The first match offered is the one ahead of the reader.
    expect(result.current.state.matches[0]?.pageNumber).toBe(4);
  });

  it('steps through matches and wraps at both ends', async () => {
    const { result } = renderSearch(documentOf(PAGES));

    act(() => {
      result.current.run({ text: 'harbour', caseSensitive: false }, 1);
    });
    await waitFor(() => {
      expect(result.current.state.status).toBe('complete');
    });

    act(() => {
      result.current.next();
    });
    expect(result.current.state.currentIndex).toBe(1);

    act(() => {
      result.current.previous();
      result.current.previous();
    });
    expect(result.current.state.currentIndex).toBe(3);

    act(() => {
      result.current.goTo(2);
    });
    expect(result.current.state.currentIndex).toBe(2);

    act(() => {
      result.current.goTo(99);
    });
    expect(result.current.state.currentIndex).toBe(2);
  });

  it('clears back to idle', async () => {
    const { result } = renderSearch(documentOf(PAGES));

    act(() => {
      result.current.run({ text: 'harbour', caseSensitive: false }, 1);
    });
    await waitFor(() => {
      expect(result.current.state.status).toBe('complete');
    });

    act(() => {
      result.current.clear();
    });

    expect(result.current.state).toMatchObject({ status: 'idle', matches: [] });
  });

  it('abandons a scan when the query changes, keeping only the new results', async () => {
    const { result } = renderSearch(documentOf(PAGES));

    act(() => {
      result.current.run({ text: 'harbour', caseSensitive: false }, 1);
      result.current.run({ text: 'interest', caseSensitive: false }, 1);
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('complete');
    });

    expect(result.current.state.query.text).toBe('interest');
    expect(result.current.state.matches).toHaveLength(1);
  });

  it('drops results belonging to a document that has been closed', async () => {
    const first = documentOf(PAGES);
    const { result, rerender } = renderHook(
      ({ document }: { document: OpenedPdf }) => useDocumentSearch(document, PAGES.length),
      { initialProps: { document: first } },
    );

    act(() => {
      result.current.run({ text: 'harbour', caseSensitive: false }, 1);
    });
    await waitFor(() => {
      expect(result.current.state.status).toBe('complete');
    });

    rerender({ document: documentOf(['an entirely different book']) });

    expect(result.current.state).toMatchObject({ status: 'idle', matches: [] });
  });

  it('searches a document with no engine at all without failing', () => {
    const { result } = renderSearch(null, 0);

    act(() => {
      result.current.run({ text: 'harbour', caseSensitive: false }, 1);
    });

    expect(result.current.state.status).toBe('idle');
  });

  it('scans a large document once through, reading each page a single time', async () => {
    const pages = Array.from({ length: 300 }, (_, index) =>
      index % 3 === 0 ? 'the harbour' : 'nothing here',
    );
    const visited: number[] = [];
    const { result } = renderSearch(
      documentOf(pages, {
        onPage: (pageNumber) => {
          visited.push(pageNumber);
        },
      }),
    );

    act(() => {
      result.current.run({ text: 'harbour', caseSensitive: false }, 1);
    });

    expect(result.current.state.status).toBe('running');

    await waitFor(
      () => {
        expect(result.current.state.status).toBe('complete');
      },
      { timeout: 5_000 },
    );

    expect(result.current.state.matches).toHaveLength(100);
    expect(result.current.state.scannedPages).toBe(300);
    expect(result.current.state.truncated).toBe(false);
    expect(visited).toHaveLength(300);
    expect(new Set(visited).size).toBe(300);
  });

  it('stops collecting at the cap and says so', async () => {
    const line = `${'harbour '.repeat(60)}`;
    const pages = Array.from({ length: 80 }, () => line);
    const { result } = renderSearch(documentOf(pages));

    act(() => {
      result.current.run({ text: 'harbour', caseSensitive: false }, 1);
    });

    await waitFor(
      () => {
        expect(result.current.state.truncated).toBe(true);
      },
      { timeout: 5_000 },
    );

    expect(result.current.state.matches).toHaveLength(MAX_MATCHES);
  });
});
