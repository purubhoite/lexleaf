import { useState, type ReactElement } from 'react';

import type {
  AnnotationsExportOutcome,
  Bookmark,
  DocumentAnnotations,
  Highlight,
  HighlightColour,
} from '@core/annotations/annotations';
import type { PdfOutlineEntry } from '@core/pdf/outline';
import type { OpenedPdf } from '@core/pdf/pdfEngine';

import { Icon } from '../../ui/Icon';
import { Message } from '../../ui/Message';
import type { PageSize } from '../model/pageLayout';
import { OutlinePanel } from '../OutlinePanel';

import { ThumbnailList } from './ThumbnailList';

/**
 * The panel beside the pages: the four ways of finding a place in a book.
 *
 * Contents (the book's own chapters), Pages (small pictures), Bookmarks
 * (pages the reader marked) and Notes (what the reader highlighted and
 * wrote). One panel with four tabs, as in most readers, rather than four
 * panels each with a button of its own.
 */

export const SIDEBAR_TABS = ['contents', 'pages', 'bookmarks', 'notes'] as const;

export type SidebarTab = (typeof SIDEBAR_TABS)[number];

const TAB_LABELS: Readonly<Record<SidebarTab, string>> = {
  contents: 'Contents',
  pages: 'Pages',
  bookmarks: 'Bookmarks',
  notes: 'Notes',
};

export interface ReaderSidebarProps {
  readonly tab: SidebarTab;
  readonly onTabChange: (tab: SidebarTab) => void;
  readonly onClose: () => void;
  /** Whether the document has real pages to show small pictures of. An EPUB does not. */
  readonly paged?: boolean;
  readonly document: OpenedPdf;
  readonly outline: readonly PdfOutlineEntry[];
  readonly sizes: readonly PageSize[];
  readonly rotation: number;
  readonly currentPage: number;
  readonly annotations: DocumentAnnotations;
  readonly onGoToPage: (pageNumber: number) => void;
  readonly onGoToHighlight: (highlight: Highlight) => void;
  readonly onRemoveBookmark: (bookmark: Bookmark) => void;
  readonly onRemoveHighlight: (highlight: Highlight) => void;
  /** Writes the highlights, notes and bookmarks to a file. Absent with nowhere to write. */
  readonly onExport?: () => Promise<AnnotationsExportOutcome>;
}

/* One class to a colour, written out for the stylesheet tests. */
const NOTE_COLOUR_CLASS: Readonly<Record<HighlightColour, string>> = {
  yellow: 'notes__mark notes__mark--yellow',
  green: 'notes__mark notes__mark--green',
  blue: 'notes__mark notes__mark--blue',
  pink: 'notes__mark notes__mark--pink',
};

const describeExport = (outcome: AnnotationsExportOutcome): string | null => {
  switch (outcome.status) {
    case 'exported':
      return outcome.count === 1 ? 'Exported 1 item.' : `Exported ${String(outcome.count)} items.`;
    case 'empty':
      return 'There is nothing to export yet.';
    case 'failed':
      return 'The notes could not be exported. Nothing was changed; try again or choose another folder.';
    case 'cancelled':
      return null;
  }
};

const BookmarkList = ({
  bookmarks,
  currentPage,
  onGoToPage,
  onRemove,
}: {
  readonly bookmarks: readonly Bookmark[];
  readonly currentPage: number;
  readonly onGoToPage: (pageNumber: number) => void;
  readonly onRemove: (bookmark: Bookmark) => void;
}): ReactElement => {
  if (bookmarks.length === 0) {
    return (
      <Message kind="empty">
        No bookmarks yet. Press the bookmark button in the bar, or Ctrl+D, to mark the page you are
        on.
      </Message>
    );
  }

  return (
    <ol className="bookmarks" data-testid="bookmarks">
      {bookmarks.map((bookmark) => (
        <li key={bookmark.page} className="bookmarks__item">
          <button
            type="button"
            className={
              bookmark.page === currentPage
                ? 'bookmarks__open bookmarks__open--current'
                : 'bookmarks__open'
            }
            data-testid="bookmark-entry"
            onClick={(): void => {
              onGoToPage(bookmark.page);
            }}
          >
            <span className="bookmarks__label">
              {bookmark.label.length > 0 ? bookmark.label : `Page ${String(bookmark.page)}`}
            </span>
            <span className="bookmarks__page" aria-label={`page ${String(bookmark.page)}`}>
              {bookmark.page}
            </span>
          </button>
          <button
            type="button"
            className="control control--quiet bookmarks__remove"
            aria-label={`Remove bookmark on page ${String(bookmark.page)}`}
            title="Remove bookmark"
            onClick={(): void => {
              onRemove(bookmark);
            }}
          >
            <Icon name="close" />
          </button>
        </li>
      ))}
    </ol>
  );
};

const NotesList = ({
  highlights,
  onGoToHighlight,
  onRemove,
}: {
  readonly highlights: readonly Highlight[];
  readonly onGoToHighlight: (highlight: Highlight) => void;
  readonly onRemove: (highlight: Highlight) => void;
}): ReactElement => {
  if (highlights.length === 0) {
    return (
      <Message kind="empty">
        No highlights yet. Select some text in the book, then choose a colour. You can add a note to
        any highlight.
      </Message>
    );
  }

  return (
    <ol className="notes" data-testid="notes">
      {highlights.map((highlight) => (
        <li key={highlight.id} className="notes__item">
          <button
            type="button"
            className="notes__open"
            data-testid="note-entry"
            onClick={(): void => {
              onGoToHighlight(highlight);
            }}
          >
            <span className={NOTE_COLOUR_CLASS[highlight.colour]} aria-hidden="true" />
            <span className="notes__body">
              <span className="notes__quote">{highlight.text}</span>
              {highlight.note.trim().length > 0 && (
                <span className="notes__note">{highlight.note}</span>
              )}
              <span className="notes__page">Page {String(highlight.page)}</span>
            </span>
          </button>
          <button
            type="button"
            className="control control--quiet notes__remove"
            aria-label={`Remove highlight on page ${String(highlight.page)}`}
            title="Remove highlight"
            onClick={(): void => {
              onRemove(highlight);
            }}
          >
            <Icon name="close" />
          </button>
        </li>
      ))}
    </ol>
  );
};

export const ReaderSidebar = ({
  tab,
  onTabChange,
  onClose,
  paged = true,
  document: pdfDocument,
  outline,
  sizes,
  rotation,
  currentPage,
  annotations,
  onGoToPage,
  onGoToHighlight,
  onRemoveBookmark,
  onRemoveHighlight,
  onExport,
}: ReaderSidebarProps): ReactElement => {
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const bookmarked = new Set(annotations.bookmarks.map((bookmark) => bookmark.page));
  const counts: Readonly<Record<SidebarTab, number | null>> = {
    contents: null,
    pages: null,
    bookmarks: annotations.bookmarks.length,
    notes: annotations.highlights.length,
  };

  return (
    <aside className="sidebar" aria-label="Sidebar" data-testid="sidebar">
      <div className="sidebar__head">
        <div className="sidebar__tabs" role="tablist" aria-label="Sidebar sections">
          {SIDEBAR_TABS.filter((candidate) => paged || candidate !== 'pages').map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              id={`sidebar-tab-${candidate}`}
              className={candidate === tab ? 'sidebar__tab sidebar__tab--active' : 'sidebar__tab'}
              aria-selected={candidate === tab}
              aria-controls="sidebar-panel"
              data-testid={`sidebar-tab-${candidate}`}
              onClick={(): void => {
                onTabChange(candidate);
              }}
            >
              {TAB_LABELS[candidate]}
              {(counts[candidate] ?? 0) > 0 && (
                <span className="sidebar__count">{String(counts[candidate])}</span>
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="control control--quiet sidebar__close"
          aria-label="Hide sidebar"
          title="Hide sidebar"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>

      <div
        className="sidebar__panel"
        role="tabpanel"
        id="sidebar-panel"
        aria-labelledby={`sidebar-tab-${tab}`}
      >
        {tab === 'contents' &&
          (outline.length === 0 ? (
            <Message kind="empty">
              This book has no table of contents. Use Pages to find your place by eye.
            </Message>
          ) : (
            <OutlinePanel entries={outline} currentPage={currentPage} onGoToPage={onGoToPage} />
          ))}

        {tab === 'pages' && paged && (
          <ThumbnailList
            document={pdfDocument}
            sizes={sizes}
            rotation={rotation}
            currentPage={currentPage}
            bookmarked={bookmarked}
            onGoToPage={onGoToPage}
          />
        )}

        {tab === 'bookmarks' && (
          <BookmarkList
            bookmarks={annotations.bookmarks}
            currentPage={currentPage}
            onGoToPage={onGoToPage}
            onRemove={onRemoveBookmark}
          />
        )}

        {tab === 'notes' && (
          <NotesList
            highlights={annotations.highlights}
            onGoToHighlight={onGoToHighlight}
            onRemove={onRemoveHighlight}
          />
        )}
      </div>

      {(tab === 'notes' || tab === 'bookmarks') && onExport !== undefined && (
        <div className="sidebar__foot">
          <button
            type="button"
            className="control"
            data-testid="notes-export"
            disabled={annotations.highlights.length + annotations.bookmarks.length === 0}
            title="Writes your highlights, notes and bookmarks to a text file"
            onClick={(): void => {
              setExportMessage(null);
              void onExport()
                .catch((): AnnotationsExportOutcome => ({ status: 'failed' }))
                .then((outcome) => {
                  setExportMessage(describeExport(outcome));
                });
            }}
          >
            Export notes…
          </button>
          {exportMessage !== null && (
            <Message kind="info" testId="notes-export-result">
              {exportMessage}
            </Message>
          )}
        </div>
      )}
    </aside>
  );
};
