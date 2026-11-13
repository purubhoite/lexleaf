import { useState, type FormEvent, type ReactElement, type ReactNode, type Ref } from 'react';

import type { ZoomState } from '@core/persistence/types';

import { Icon } from '../ui/Icon';

import { PAGE_LAYOUT_MODES, type PageLayoutMode } from './model/pageLayout';
import { describeZoom, ZOOM_LEVELS, formatZoomPercentage } from './model/zoom';

/**
 * The reader's controls.
 *
 * Every control is a real button or form field with an accessible name, in a
 * sensible tab order, so that the whole reader can be driven from the
 * keyboard (PRODUCT_SPEC section 8, principle 6). Nothing here holds reader
 * state; the view above owns it.
 */

export interface ReaderToolbarProps {
  readonly documentName: string;
  readonly currentPage: number;
  readonly pageCount: number;
  readonly zoom: ZoomState;
  readonly scale: number;
  readonly searchOpen: boolean;
  /** Whether the document has real pages. An EPUB does not: no page views, rotation or print. */
  readonly paged?: boolean;
  readonly sidebarOpen: boolean;
  readonly onToggleSidebar: () => void;
  /** Whether there is a place to go back to after a jump. */
  readonly canGoBack: boolean;
  readonly onGoBack: () => void;
  /** Whether the page being read is bookmarked. */
  readonly bookmarked: boolean;
  readonly onToggleBookmark: () => void;
  readonly viewMode: PageLayoutMode;
  readonly onViewModeChange: (mode: PageLayoutMode) => void;
  readonly onRotate: () => void;
  readonly onPrint: () => void;
  readonly onGoToPage: (pageNumber: number) => void;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onZoomChange: (zoom: ZoomState) => void;
  readonly onToggleSearch: () => void;
  /** The page-number field, so "Go to page" can put the cursor in it. */
  readonly pageFieldRef?: Ref<HTMLInputElement>;
  /** Controls that belong to the application rather than the document, shown last. */
  readonly trailing?: ReactNode;
}

const ZOOM_SELECT_FIT_WIDTH = 'fit-width';
const ZOOM_SELECT_FIT_PAGE = 'fit-page';

export const ReaderToolbar = ({
  documentName,
  currentPage,
  pageCount,
  zoom,
  scale,
  searchOpen,
  paged = true,
  sidebarOpen,
  onToggleSidebar,
  canGoBack,
  onGoBack,
  bookmarked,
  onToggleBookmark,
  viewMode,
  onViewModeChange,
  onRotate,
  onPrint,
  onGoToPage,
  onZoomIn,
  onZoomOut,
  onZoomChange,
  onToggleSearch,
  pageFieldRef,
  trailing,
}: ReaderToolbarProps): ReactElement => {
  // While the reader is not editing it, the field simply shows where they
  // are; it only holds its own value between a keystroke and a submission,
  // so scrolling never fights with typing.
  // Two pages side by side turn two at a time.
  const pageStep = viewMode === 'two' ? 2 : 1;
  const [draft, setDraft] = useState<string | null>(null);
  const pageField = draft ?? String(currentPage);

  const submitPage = (event: FormEvent): void => {
    event.preventDefault();

    const requested = Number.parseInt(pageField, 10);

    setDraft(null);

    if (Number.isFinite(requested)) {
      onGoToPage(Math.min(Math.max(requested, 1), pageCount));
    }
  };

  const zoomValue =
    zoom.mode === 'fixed'
      ? String(zoom.scale)
      : zoom.mode === 'fit-width'
        ? ZOOM_SELECT_FIT_WIDTH
        : ZOOM_SELECT_FIT_PAGE;

  return (
    <header className="reader__bar">
      {/*
        CTL-1. Groups, in the order the reader works through them: file
        (with the sidebar and the way back, which belong to the book as a
        whole), page, zoom, view, marks, search. Each one is a real `role="group"` with a
        name, so landmark-free navigation still reports where a control
        belongs, and `.reader__group` draws the boundary that makes the
        same four groups visible on screen.

        The first group was called "Document" until 6.5. So is the
        scrolling region that holds the pages, and the 6.4 acceptance
        audit found the two sharing one accessible name (condition C6):
        a reader hearing "Document" had no way to tell which of them had
        been reached. This group is the file: it names the one that is
        open. Opening and closing live in the File menu (and Ctrl+O,
        Ctrl+W) since 0.2.5; the buttons crowded the name out of the bar. The region keeps the name it has
        had since 6.2, because that is the thing a reader is looking for
        when they go looking for the document.
      */}
      <div className="reader__group reader__group--document" role="group" aria-label="File">
        {/*
          One button for the sidebar, which holds the contents, the page
          thumbnails, the bookmarks and the notes. It is always there, so
          it is always in the same place, whatever the book has in it.
        */}
        <button
          type="button"
          className="control control--quiet"
          data-testid="outline-toggle"
          aria-label="Sidebar"
          aria-expanded={sidebarOpen}
          title="Sidebar"
          onClick={onToggleSidebar}
        >
          <Icon name="sidebar" />
        </button>
        <button
          type="button"
          className="control control--quiet"
          data-testid="go-back"
          aria-label="Back to where you were"
          title="Back to where you were"
          disabled={!canGoBack}
          onClick={onGoBack}
        >
          <Icon name="back" />
        </button>
        <span className="reader__name" title={documentName}>
          {documentName}
        </span>
      </div>

      <div className="reader__group" role="group" aria-label="Page navigation">
        <button
          type="button"
          className="control control--quiet"
          aria-label="Previous page"
          title="Previous page"
          disabled={currentPage <= 1}
          onClick={(): void => {
            onGoToPage(currentPage - 1);
          }}
        >
          <Icon name="chevron-left" />
        </button>

        <form className="reader__page-form" onSubmit={submitPage}>
          <label>
            <span className="visually-hidden">Page number</span>
            <input
              ref={pageFieldRef}
              className="control control--field reader__page-input"
              inputMode="numeric"
              value={pageField}
              onChange={(event): void => {
                setDraft(event.target.value);
              }}
              onBlur={submitPage}
            />
          </label>
          <span> of {pageCount}</span>
        </form>

        <button
          type="button"
          className="control control--quiet"
          aria-label="Next page"
          title="Next page"
          disabled={currentPage + pageStep > pageCount}
          onClick={(): void => {
            onGoToPage(currentPage + pageStep);
          }}
        >
          <Icon name="chevron-right" />
        </button>
      </div>

      <div className="reader__group" role="group" aria-label="Zoom">
        <button
          type="button"
          className="control control--quiet"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={onZoomOut}
        >
          <Icon name="minus" />
        </button>
        <label>
          <span className="visually-hidden">Zoom level</span>
          {/*
            The accessible name comes from the label alone and stays "Zoom
            level" whatever the value is (W12, AC 9). It previously carried
            an `aria-label` built from the current zoom, which overrode the
            label and renamed the control every time its value changed; the
            value is already conveyed by the selected option, and a
            fitted mode states its percentage in its own option.
          */}
          <select
            className="control control--quiet"
            value={zoomValue}
            onChange={(event): void => {
              const value = event.target.value;

              if (value === ZOOM_SELECT_FIT_WIDTH || value === ZOOM_SELECT_FIT_PAGE) {
                onZoomChange({ mode: value, scale });
              } else {
                onZoomChange({ mode: 'fixed', scale: Number(value) });
              }
            }}
          >
            {/*
              The fitted modes say what they came to, in the menu itself:
              "Fit width (137 %)". That figure used to be a second readout
              beside the menu, repeating the menu whenever a fixed level
              was chosen.
            */}
            <option value={ZOOM_SELECT_FIT_WIDTH}>
              {zoom.mode === 'fit-width' ? describeZoom(zoom, scale) : 'Fit width'}
            </option>
            <option value={ZOOM_SELECT_FIT_PAGE}>
              {zoom.mode === 'fit-page' ? describeZoom(zoom, scale) : 'Fit page'}
            </option>
            {/*
              A zoom reached by pinching is rarely one of the listed
              levels. It is shown as itself, so the menu always says the
              zoom the page is actually at.
            */}
            {zoom.mode === 'fixed' && !ZOOM_LEVELS.some((level) => level === zoom.scale) && (
              <option value={String(zoom.scale)}>{formatZoomPercentage(zoom.scale)}</option>
            )}
            {ZOOM_LEVELS.map((level) => (
              <option key={level} value={level}>
                {formatZoomPercentage(level)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="control control--quiet"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={onZoomIn}
        >
          <Icon name="plus" />
        </button>
      </div>

      {paged && (
        <div className="reader__group" role="group" aria-label="Page view">
          <label className="reader__zoom">
            <span className="visually-hidden">Page view</span>
            <select
              className="control control--quiet"
              value={viewMode}
              data-testid="view-mode"
              onChange={(event): void => {
                const chosen = PAGE_LAYOUT_MODES.find((mode) => mode === event.target.value);

                if (chosen !== undefined) {
                  onViewModeChange(chosen);
                }
              }}
            >
              <option value="continuous">Scrolling</option>
              <option value="single">One page</option>
              <option value="two">Two pages</option>
            </select>
          </label>
          <button
            type="button"
            className="control control--quiet"
            aria-label="Rotate pages"
            title="Rotate pages"
            data-testid="rotate"
            onClick={onRotate}
          >
            <Icon name="rotate-right" />
          </button>
        </div>
      )}

      <div className="reader__group" role="group" aria-label="Bookmark and print">
        <button
          type="button"
          className={bookmarked ? 'control control--quiet control--on' : 'control control--quiet'}
          aria-label={bookmarked ? 'Remove bookmark from this page' : 'Bookmark this page'}
          aria-pressed={bookmarked}
          title={bookmarked ? 'Remove bookmark from this page' : 'Bookmark this page'}
          data-testid="bookmark-toggle"
          onClick={onToggleBookmark}
        >
          <Icon name="bookmark" />
        </button>
        {paged && (
          <button
            type="button"
            className="control control--quiet"
            aria-label="Print"
            title="Print"
            data-testid="print"
            onClick={onPrint}
          >
            <Icon name="print" />
          </button>
        )}
      </div>

      <div className="reader__group" role="group" aria-label="Find">
        <button
          type="button"
          className="control control--quiet"
          aria-label="Search"
          aria-expanded={searchOpen}
          title="Search"
          onClick={onToggleSearch}
        >
          <Icon name="search" />
        </button>
      </div>

      {trailing}
    </header>
  );
};
