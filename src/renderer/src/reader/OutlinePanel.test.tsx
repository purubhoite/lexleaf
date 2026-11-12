/** @vitest-environment jsdom */
import type { PdfOutlineEntry } from '@core/pdf/outline';
import type { OpenedPdf } from '@core/pdf/pdfEngine';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OutlinePanel } from './OutlinePanel';
import { useDocumentOutline } from './useDocumentOutline';

const entries: PdfOutlineEntry[] = [
  { title: 'Part One', pageNumber: 1, depth: 0 },
  { title: 'Chapter 1', pageNumber: 3, depth: 1 },
  { title: 'Publisher’s site', pageNumber: null, depth: 1 },
  { title: 'Chapter 2', pageNumber: 20, depth: 1 },
];

afterEach(() => {
  cleanup();
});

describe('the contents panel', () => {
  it('lists the entries under a named landmark', () => {
    render(
      <OutlinePanel entries={entries} currentPage={1} onGoToPage={vi.fn()} onClose={vi.fn()} />,
    );

    expect(screen.getByRole('navigation', { name: 'Contents' })).toBeDefined();
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toStrictEqual([
      'Part One1',
      'Chapter 13',
      'Publisher’s site',
      'Chapter 220',
    ]);
  });

  it('goes to the page of the entry that was chosen', () => {
    const onGoToPage = vi.fn();
    render(
      <OutlinePanel entries={entries} currentPage={1} onGoToPage={onGoToPage} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Chapter 2/ }));

    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(20);
  });

  it('does not offer to go where an entry does not lead', () => {
    render(
      <OutlinePanel entries={entries} currentPage={1} onGoToPage={vi.fn()} onClose={vi.fn()} />,
    );

    expect(screen.queryByRole('button', { name: /Publisher/ })).toBeNull();
    expect(screen.getAllByTestId('outline-entry')).toHaveLength(3);
  });

  it('marks the entry the reader is in, and only that one', () => {
    render(
      <OutlinePanel entries={entries} currentPage={12} onGoToPage={vi.fn()} onClose={vi.fn()} />,
    );

    const marked = screen
      .getAllByTestId('outline-entry')
      .filter((entry) => entry.getAttribute('aria-current') === 'location');

    expect(marked.map((entry) => entry.textContent)).toStrictEqual(['Chapter 13']);
  });

  it('can be hidden', () => {
    const onClose = vi.fn();
    render(
      <OutlinePanel entries={entries} currentPage={1} onGoToPage={vi.fn()} onClose={onClose} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Hide contents' }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('reading a document’s outline', () => {
  const documentWith = (outline: () => Promise<readonly PdfOutlineEntry[]>): OpenedPdf =>
    ({ getOutline: outline }) as unknown as OpenedPdf;

  it('is empty with no document, and until the outline arrives', async () => {
    const { result, rerender } = renderHook(
      ({ document }: { document: OpenedPdf | null }) => useDocumentOutline(document),
      { initialProps: { document: null as OpenedPdf | null } },
    );

    expect(result.current).toStrictEqual([]);

    rerender({ document: documentWith(() => Promise.resolve(entries)) });

    expect(result.current).toStrictEqual([]);
    await waitFor(() => {
      expect(result.current).toStrictEqual(entries);
    });
  });

  it('never shows one document the outline of another', async () => {
    let deliverFirst: (value: readonly PdfOutlineEntry[]) => void = () => undefined;
    const first = documentWith(
      () =>
        new Promise((resolve) => {
          deliverFirst = resolve;
        }),
    );
    const second = documentWith(() => Promise.resolve([]));
    const { result, rerender } = renderHook(
      ({ document }: { document: OpenedPdf | null }) => useDocumentOutline(document),
      { initialProps: { document: first as OpenedPdf | null } },
    );

    rerender({ document: second });
    await act(async () => {
      deliverFirst(entries);
      await Promise.resolve();
    });

    expect(result.current).toStrictEqual([]);
  });

  it('forgets the outline as soon as another document is opened', async () => {
    const first = documentWith(() => Promise.resolve(entries));
    const second = documentWith(() => new Promise(() => undefined));
    const { result, rerender } = renderHook(
      ({ document }: { document: OpenedPdf | null }) => useDocumentOutline(document),
      { initialProps: { document: first as OpenedPdf | null } },
    );

    await waitFor(() => {
      expect(result.current).toHaveLength(4);
    });

    rerender({ document: second });

    expect(result.current).toStrictEqual([]);
  });

  it('treats an outline that cannot be read as none', async () => {
    const { result } = renderHook(() =>
      useDocumentOutline(documentWith(() => Promise.reject(new Error('broken')))),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toStrictEqual([]);
  });
});
