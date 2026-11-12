import { useState, type FormEvent, type ReactElement } from 'react';

import type { ZoomState } from '@core/persistence/types';

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
  /** Whether the document has a table of contents to show. */
  readonly hasOutline: boolean;
  readonly outlineOpen: boolean;
  readonly onToggleOutline: () => void;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly onGoToPage: (pageNumber: number) => void;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onZoomChange: (zoom: ZoomState) => void;
  readonly onToggleSearch: () => void;
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
  hasOutline,
  outlineOpen,
  onToggleOutline,
  onOpen,
  onClose,
  onGoToPage,
  onZoomIn,
  onZoomOut,
  onZoomChange,
  onToggleSearch,
}: ReaderToolbarProps): ReactElement => {
  // While the reader is not editing it, the field simply shows where they
  // are; it only holds its own value between a keystroke and a submission,
  // so scrolling never fights with typing.
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
        CTL-1. Four groups, in the order the reader works through them:
        file, page, zoom, search. Each one is a real `role="group"` with a
        name, so landmark-free navigation still reports where a control
        belongs, and `.reader__group` draws the boundary that makes the
        same four groups visible on screen.

        The first group was called "Document" until 6.5. So is the
        scrolling region that holds the pages, and the 6.4 acceptance
        audit found the two sharing one accessible name (condition C6):
        a reader hearing "Document" had no way to tell which of them had
        been reached. This group is the file: it opens one, closes one,
        and names the one that is open. The region keeps the name it has
        had since 6.2, because that is the thing a reader is looking for
        when they go looking for the document.
      */}
      <div className="reader__group reader__group--document" role="group" aria-label="File">
        <button type="button" className="control" onClick={onOpen}>
          Open PDF…
        </button>
        <button type="button" className="control" onClick={onClose}>
          Close
        </button>
        <span className="reader__name" title={documentName}>
          {documentName}
        </span>
      </div>

      <div className="reader__group" role="group" aria-label="Page navigation">
        {/*
          The contents button lives with page navigation because that is
          what it is. A document without an outline keeps the button, off,
          with the reason in its tooltip: a control that comes and goes
          between books is harder to find than one that says "not here".
        */}
        <button
          type="button"
          className="control"
          data-testid="outline-toggle"
          aria-expanded={hasOutline && outlineOpen}
          disabled={!hasOutline}
          title={hasOutline ? 'Table of contents' : 'This document has no table of contents'}
          onClick={onToggleOutline}
        >
          Contents
        </button>
        <button
          type="button"
          className="control"
          aria-label="First page"
          title="First page"
          disabled={currentPage <= 1}
          onClick={(): void => {
            onGoToPage(1);
          }}
        >
          ⏮
        </button>
        <button
          type="button"
          className="control"
          aria-label="Previous page"
          title="Previous page"
          disabled={currentPage <= 1}
          onClick={(): void => {
            onGoToPage(currentPage - 1);
          }}
        >
          ◀
        </button>

        <form className="reader__page-form" onSubmit={submitPage}>
          <label>
            <span className="visually-hidden">Page number</span>
            <input
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
          className="control"
          aria-label="Next page"
          title="Next page"
          disabled={currentPage >= pageCount}
          onClick={(): void => {
            onGoToPage(currentPage + 1);
          }}
        >
          ▶
        </button>
        <button
          type="button"
          className="control"
          aria-label="Last page"
          title="Last page"
          disabled={currentPage >= pageCount}
          onClick={(): void => {
            onGoToPage(pageCount);
          }}
        >
          ⏭
        </button>
      </div>

      <div className="reader__group" role="group" aria-label="Zoom">
        <button
          type="button"
          className="control"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={onZoomOut}
        >
          −
        </button>
        <label>
          <span className="visually-hidden">Zoom level</span>
          {/*
            The accessible name comes from the label alone and stays "Zoom
            level" whatever the value is (W12, AC 9). It previously carried
            an `aria-label` built from the current zoom, which overrode the
            label and renamed the control every time its value changed; the
            value is already conveyed by the selected option, and the
            readout beside it states it visibly.
          */}
          <select
            className="control"
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
            <option value={ZOOM_SELECT_FIT_WIDTH}>Fit width</option>
            <option value={ZOOM_SELECT_FIT_PAGE}>Fit page</option>
            {ZOOM_LEVELS.map((level) => (
              <option key={level} value={level}>
                {formatZoomPercentage(level)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="control"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={onZoomIn}
        >
          +
        </button>
        <span className="reader__zoom-readout">{describeZoom(zoom, scale)}</span>
      </div>

      <div className="reader__group" role="group" aria-label="Search">
        <button
          type="button"
          className="control"
          aria-expanded={searchOpen}
          onClick={onToggleSearch}
        >
          Search
        </button>
      </div>
    </header>
  );
};
