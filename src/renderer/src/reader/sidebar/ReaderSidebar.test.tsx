/** @vitest-environment jsdom */
import type { DocumentAnnotations } from '@core/annotations/annotations';
import type { OpenedPdf } from '@core/pdf/pdfEngine';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReaderSidebar, type ReaderSidebarProps, type SidebarTab } from './ReaderSidebar';

afterEach(() => {
  cleanup();
});

const annotations: DocumentAnnotations = {
  highlights: [
    {
      id: 'h1',
      page: 2,
      start: 0,
      end: 5,
      text: 'A marked passage',
      colour: 'green',
      note: 'Why this matters',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  bookmarks: [{ page: 7, label: 'Chapter 2', createdAt: '2026-01-01T00:00:00.000Z' }],
  rotation: 0,
};

const show = (tab: SidebarTab, overrides: Partial<ReaderSidebarProps> = {}) => {
  const props: ReaderSidebarProps = {
    tab,
    onTabChange: vi.fn(),
    onClose: vi.fn(),
    document: { getNativePage: () => new Promise(() => undefined) } as unknown as OpenedPdf,
    outline: [{ title: 'Part One', pageNumber: 1, depth: 0 }],
    sizes: [
      { width: 600, height: 800 },
      { width: 600, height: 800 },
      { width: 800, height: 600 },
    ],
    rotation: 0,
    currentPage: 2,
    annotations,
    onGoToPage: vi.fn(),
    onGoToHighlight: vi.fn(),
    onRemoveBookmark: vi.fn(),
    onRemoveHighlight: vi.fn(),
    ...overrides,
  };

  render(<ReaderSidebar {...props} />);

  return props;
};

describe('the sidebar', () => {
  it('offers four sections and says which is showing', () => {
    const props = show('contents');

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toStrictEqual([
      'Contents',
      'Pages',
      'Bookmarks1',
      'Notes1',
    ]);
    expect(screen.getByTestId('sidebar-tab-contents').getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByTestId('sidebar-tab-notes'));

    expect(props.onTabChange).toHaveBeenCalledWith('notes');
  });

  it('says so when the book has no contents, and points at the pages', () => {
    show('contents', { outline: [] });

    expect(screen.getByText(/no table of contents/u)).toBeDefined();
  });

  it('shows a page-shaped button for every page and goes there', () => {
    const props = show('pages');
    const pages = screen.getAllByTestId('thumbnail');

    expect(pages).toHaveLength(3);
    expect(pages[1]?.getAttribute('aria-current')).toBe('page');

    fireEvent.click(pages[2] as HTMLElement);

    expect(props.onGoToPage).toHaveBeenCalledWith(3);
  });

  it('lists bookmarks by name and page, opens them and removes them', () => {
    const props = show('bookmarks');

    fireEvent.click(screen.getByTestId('bookmark-entry'));
    expect(props.onGoToPage).toHaveBeenCalledWith(7);

    fireEvent.click(screen.getByRole('button', { name: 'Remove bookmark on page 7' }));
    expect(props.onRemoveBookmark).toHaveBeenCalledWith(annotations.bookmarks[0]);
  });

  it('lists highlights with their notes, opens them and removes them', () => {
    const props = show('notes');
    const entry = screen.getByTestId('note-entry');

    expect(entry.textContent).toContain('A marked passage');
    expect(entry.textContent).toContain('Why this matters');
    expect(entry.textContent).toContain('Page 2');

    fireEvent.click(entry);
    expect(props.onGoToHighlight).toHaveBeenCalledWith(annotations.highlights[0]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove highlight on page 2' }));
    expect(props.onRemoveHighlight).toHaveBeenCalledWith(annotations.highlights[0]);
  });

  it('explains how to begin when there is nothing yet', () => {
    show('notes', { annotations: { highlights: [], bookmarks: [], rotation: 0 } });

    expect(screen.getByText(/Select some text/u)).toBeDefined();
  });

  it('exports and says what happened', async () => {
    const onExport = vi.fn(() => Promise.resolve({ status: 'exported' as const, count: 2 }));
    show('notes', { onExport });

    fireEvent.click(screen.getByTestId('notes-export'));

    expect((await screen.findByTestId('notes-export-result')).textContent).toBe(
      'Exported 2 items.',
    );
  });

  it('says nothing when the reader cancelled, and reports a failure plainly', async () => {
    const onExport = vi
      .fn()
      .mockResolvedValueOnce({ status: 'cancelled' })
      .mockRejectedValueOnce(new Error('disk'));
    show('notes', { onExport });

    fireEvent.click(screen.getByTestId('notes-export'));
    await Promise.resolve();
    expect(screen.queryByTestId('notes-export-result')).toBeNull();

    fireEvent.click(screen.getByTestId('notes-export'));
    expect((await screen.findByTestId('notes-export-result')).textContent).toContain(
      'could not be exported',
    );
  });

  it('has no export button with nowhere to write', () => {
    show('notes');

    expect(screen.queryByTestId('notes-export')).toBeNull();
  });
});
