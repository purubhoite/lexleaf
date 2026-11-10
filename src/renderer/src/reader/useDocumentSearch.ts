import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { OpenedPdf } from '@core/pdf/pdfEngine';
import { findMatchesInText, isRunnableQuery, stepMatch } from '@core/search/findMatches';
import type { SearchMatch, SearchQuery } from '@core/search/types';
import { joinSegments } from '@core/word/identifyWord';

/**
 * Searching the whole document.
 *
 * Search reads the text the *engine* extracted, not the DOM, so it covers
 * pages that have never been rendered and is unaffected by what is on screen
 * — a reader can search while the document is still laying itself out.
 *
 * The scan is asynchronous and yields between chunks. Reading 400 pages of
 * text takes about 1.5 s; doing that in one synchronous burst would freeze
 * the window, and doing it in a worker would mean a second PDF.js instance.
 * Yielding keeps the window responsive and lets matches appear as they are
 * found.
 */

/** Pages scanned between yields to the event loop. */
const CHUNK = 10;

/** Refuses to collect more than this; a one-letter query on a book otherwise would. */
export const MAX_MATCHES = 2_000;

export type SearchStatus = 'idle' | 'running' | 'complete';

export interface SearchState {
  readonly status: SearchStatus;
  readonly query: SearchQuery;
  readonly matches: readonly SearchMatch[];
  /** Index into `matches`, or null when there is nothing to be on. */
  readonly currentIndex: number | null;
  readonly scannedPages: number;
  readonly totalPages: number;
  /** True when the scan stopped because the cap was reached. */
  readonly truncated: boolean;
}

export interface SearchControls {
  readonly state: SearchState;
  readonly run: (query: SearchQuery, fromPage: number) => void;
  readonly next: () => void;
  readonly previous: () => void;
  readonly goTo: (index: number) => void;
  readonly clear: () => void;
}

const EMPTY_QUERY: SearchQuery = { text: '', caseSensitive: false };

const idleState = (totalPages: number): SearchState => ({
  status: 'idle',
  query: EMPTY_QUERY,
  matches: [],
  currentIndex: null,
  scannedPages: 0,
  totalPages,
  truncated: false,
});

/** Search results only mean anything alongside the document they came from. */
interface OwnedSearchState extends SearchState {
  readonly source: OpenedPdf | null;
}

export const useDocumentSearch = (
  document: OpenedPdf | null,
  pageCount: number,
): SearchControls => {
  const [state, setState] = useState<OwnedSearchState>(() => ({
    ...idleState(pageCount),
    source: null,
  }));
  const run = useRef(0);
  const openDocument = useRef(document);

  // A scan that outlives its document stops at the next chunk boundary.
  useEffect(() => {
    openDocument.current = document;
  }, [document]);

  // Results from the previous document are never shown: a document switch
  // puts search back in its idle state without an extra render.
  const visibleState = useMemo<SearchState>(
    () => (state.source === document ? state : idleState(pageCount)),
    [state, document, pageCount],
  );

  const start = useCallback(
    (query: SearchQuery, fromPage: number): void => {
      run.current += 1;
      const generation = run.current;

      if (document === null || !isRunnableQuery(query)) {
        setState({ ...idleState(pageCount), query, source: document });
        return;
      }

      setState({
        source: document,
        status: 'running',
        query,
        matches: [],
        currentIndex: null,
        scannedPages: 0,
        totalPages: pageCount,
        truncated: false,
      });

      const scan = async (): Promise<void> => {
        const found: SearchMatch[] = [];
        let truncated = false;

        // Scanning starts at the reader's page and wraps, so the first match
        // offered is the next one *ahead of them*, not the first in the book.
        const order = Array.from({ length: pageCount }, (_, index) => {
          const offset = (index + fromPage - 1) % pageCount;

          return offset + 1;
        });

        for (const [scanned, pageNumber] of order.entries()) {
          if (run.current !== generation || openDocument.current !== document) {
            return;
          }

          const { segments } = await document.getPageText(pageNumber);
          const { text } = joinSegments(segments);

          found.push(...findMatchesInText(text, pageNumber, query));

          if (found.length >= MAX_MATCHES) {
            truncated = true;
          }

          if (truncated || scanned % CHUNK === CHUNK - 1 || scanned === order.length - 1) {
            const matches = [...found].slice(0, MAX_MATCHES);

            setState((current) =>
              current.query === query && run.current === generation
                ? {
                    ...current,
                    matches,
                    currentIndex: current.currentIndex ?? (matches.length > 0 ? 0 : null),
                    scannedPages: scanned + 1,
                    truncated,
                  }
                : current,
            );

            if (truncated) {
              break;
            }

            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }

        if (run.current === generation) {
          setState((current) => ({ ...current, status: 'complete' }));
        }
      };

      void scan().catch(() => {
        if (run.current === generation) {
          setState((current) => ({ ...current, status: 'complete' }));
        }
      });
    },
    [document, pageCount],
  );

  const move = useCallback((step: 1 | -1): void => {
    setState((current) =>
      current.matches.length === 0
        ? current
        : {
            ...current,
            currentIndex: stepMatch(current.matches.length, current.currentIndex ?? 0, step),
          },
    );
  }, []);

  return {
    state: visibleState,
    run: start,
    next: useCallback(() => {
      move(1);
    }, [move]),
    previous: useCallback(() => {
      move(-1);
    }, [move]),
    goTo: useCallback((index: number) => {
      setState((current) =>
        index >= 0 && index < current.matches.length
          ? { ...current, currentIndex: index }
          : current,
      );
    }, []),
    clear: useCallback(() => {
      run.current += 1;
      setState({ ...idleState(pageCount), source: document });
    }, [pageCount, document]),
  };
};
