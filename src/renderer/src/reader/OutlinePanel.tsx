import { useEffect, useRef, type ReactElement } from 'react';

import { activeOutlineIndex, type PdfOutlineEntry } from '@core/pdf/outline';

/**
 * The table of contents, beside the pages.
 *
 * It shows what the document's author put in its outline, in their order
 * and with their nesting, and marks the entry the reader is in. Choosing
 * an entry goes to its page. An entry that points nowhere in this document
 * (a web link, a broken destination) is shown as plain text: it is part of
 * the contents, but there is nowhere to take the reader.
 */

export interface OutlinePanelProps {
  readonly entries: readonly PdfOutlineEntry[];
  readonly currentPage: number;
  readonly onGoToPage: (pageNumber: number) => void;
  readonly onClose: () => void;
}

export const OutlinePanel = ({
  entries,
  currentPage,
  onGoToPage,
  onClose,
}: OutlinePanelProps): ReactElement => {
  const active = activeOutlineIndex(entries, currentPage);
  const activeRef = useRef<HTMLLIElement | null>(null);

  // Keep the reader's place in a long list in view as they read on.
  useEffect(() => {
    const element = activeRef.current;

    if (element !== null && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [active]);

  return (
    <nav className="outline" aria-label="Contents" data-testid="outline">
      <div className="outline__head">
        <h2 className="outline__title">Contents</h2>
        <button type="button" className="control" onClick={onClose} aria-label="Hide contents">
          Hide
        </button>
      </div>
      <ol className="outline__list">
        {entries.map((entry, index) => {
          const isActive = index === active;
          const indent = { paddingInlineStart: `calc(var(--space-3) * ${String(entry.depth)})` };

          return (
            // The list never changes for an open document, so position is identity.
            <li key={index} ref={isActive ? activeRef : null} style={indent}>
              {entry.pageNumber === null ? (
                <span className="outline__entry outline__entry--nowhere">
                  <span className="outline__text">{entry.title}</span>
                </span>
              ) : (
                <button
                  type="button"
                  className={`outline__entry${isActive ? ' outline__entry--active' : ''}`}
                  data-testid="outline-entry"
                  aria-current={isActive ? 'location' : undefined}
                  title={entry.title}
                  onClick={(): void => {
                    if (entry.pageNumber !== null) {
                      onGoToPage(entry.pageNumber);
                    }
                  }}
                >
                  <span className="outline__text">{entry.title}</span>
                  <span className="outline__page" aria-label={`page ${String(entry.pageNumber)}`}>
                    {entry.pageNumber}
                  </span>
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};
