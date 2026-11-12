/**
 * @vitest-environment jsdom
 */

import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { OpenedPdf } from '@core/pdf/pdfEngine';
import type { PdfPageSize } from '@core/pdf/types';

import { usePageMetrics } from './usePageMetrics';

const documentOf = (
  sizes: readonly { width: number; height: number; rotation?: number }[],
  onPage?: (pageNumber: number) => void,
): OpenedPdf => ({
  pageCount: sizes.length,
  label: 'fake.pdf',
  getPageText: (pageNumber: number) =>
    Promise.resolve({ pageNumber, segments: [], hasTextLayer: true }),
  getPageSize: (pageNumber: number): Promise<PdfPageSize> => {
    onPage?.(pageNumber);

    const size = sizes[pageNumber - 1] ?? { width: 0, height: 0 };

    return Promise.resolve({
      width: size.width,
      height: size.height,
      rotation: size.rotation ?? 0,
    });
  },
  getOutline: () => Promise.resolve([]),
  getNativePage: () => Promise.resolve({}),
  close: () => Promise.resolve(),
});

const uniform = (count: number): { width: number; height: number }[] =>
  Array.from({ length: count }, () => ({ width: 595, height: 842 }));

describe('usePageMetrics', () => {
  it('has nothing to measure without a document', () => {
    const { result } = renderHook(() => usePageMetrics(null, 0));

    expect(result.current).toEqual({ sizes: [], measured: 0, reference: null });
  });

  it('gives every page a usable size immediately, before measuring finishes', () => {
    const document = documentOf(uniform(400));
    const { result } = renderHook(() => usePageMetrics(document, 400));

    expect(result.current.sizes).toHaveLength(400);
    expect(result.current.measured).toBe(0);
    expect(result.current.sizes[399]).toEqual({ width: 612, height: 792 });
  });

  it('measures every page and reports how far it has got', async () => {
    const document = documentOf(uniform(60));
    const { result } = renderHook(() => usePageMetrics(document, 60));

    await waitFor(() => {
      expect(result.current.measured).toBe(60);
    });

    expect(result.current.sizes.every((size) => size.height === 842)).toBe(true);
  });

  it('uses the first measured page for pages not measured yet', async () => {
    const sizes = [{ width: 1_000, height: 500 }, ...uniform(39)];
    const document = documentOf(sizes);
    const { result } = renderHook(() => usePageMetrics(document, 40));

    await waitFor(() => {
      expect(result.current.measured).toBeGreaterThan(0);
    });

    expect(result.current.sizes[0]).toEqual({ width: 1_000, height: 500 });
  });

  it('reports the largest page, which is what the fit modes are measured against', async () => {
    const document = documentOf([
      { width: 595, height: 842 },
      { width: 1_190, height: 1_684 },
      { width: 595, height: 842 },
    ]);
    const { result } = renderHook(() => usePageMetrics(document, 3));

    await waitFor(() => {
      expect(result.current.measured).toBe(3);
    });

    expect(result.current.reference).toEqual({ width: 1_190, height: 1_684 });
  });

  it('measures each page exactly once', async () => {
    const visited: number[] = [];
    const document = documentOf(uniform(30), (pageNumber) => {
      visited.push(pageNumber);
    });
    const { result } = renderHook(() => usePageMetrics(document, 30));

    await waitFor(() => {
      expect(result.current.measured).toBe(30);
    });

    expect(visited).toHaveLength(30);
    expect(new Set(visited).size).toBe(30);
  });

  it('never shows one document’s page sizes for another', async () => {
    const first = documentOf([{ width: 1_000, height: 2_000 }]);
    const second = documentOf([{ width: 300, height: 400 }]);
    const { result, rerender } = renderHook(
      ({ document, pages }: { document: OpenedPdf; pages: number }) =>
        usePageMetrics(document, pages),
      { initialProps: { document: first, pages: 1 } },
    );

    await waitFor(() => {
      expect(result.current.measured).toBe(1);
    });

    rerender({ document: second, pages: 1 });

    // The previous document's measurements are discarded at once.
    expect(result.current.measured).toBe(0);

    await waitFor(() => {
      expect(result.current.sizes[0]).toEqual({ width: 300, height: 400 });
    });
  });

  it('stops measuring when the document is closed mid-pass', async () => {
    const visited: number[] = [];
    const document = documentOf(uniform(200), (pageNumber) => {
      visited.push(pageNumber);
    });
    const { unmount } = renderHook(() => usePageMetrics(document, 200));

    await vi.waitFor(() => {
      expect(visited.length).toBeGreaterThan(0);
    });

    unmount();

    const seen = visited.length;

    await new Promise((resolve) => setTimeout(resolve, 20));

    // At most the chunk that was already in flight finishes.
    expect(visited.length).toBeLessThanOrEqual(seen + 25);
    expect(visited.length).toBeLessThan(200);
  });
});
