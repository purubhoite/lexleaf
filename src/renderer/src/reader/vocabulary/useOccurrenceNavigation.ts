import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { locateSavedWord } from '@core/vocabulary/locate';
import { joinSegments } from '@core/word/identifyWord';

import type { PageRegistry } from '../interaction/pageRegistry';

/**
 * Going back to where a word was met.
 *
 * The journey has four steps and each one can fail honestly: open the
 * document the word came from, go to the page, wait for that page to
 * actually render, then find the word on it. What is stored is only ever a
 * document identity, a page, an optional character range and an optional
 * offset down the page — never a PDF.js object, never a render generation,
 * never a scroll position in pixels.
 *
 * The outcomes are deliberately distinguishable. A highlight on the exact
 * saved range, a highlight on the first matching word with the reader told
 * it is approximate, or a plain statement that the word is not on that
 * page any more. Nothing here guesses silently, and nothing here writes
 * the reader's remembered position: arriving somewhere to look is not the
 * same as leaving off there.
 */

export interface OccurrenceTarget {
  readonly itemId: string;
  readonly word: string;
  /** Normalised form, used to verify the anchor still points at the word. */
  readonly normalized: string;
  readonly documentId: string;
  readonly documentName: string;
  readonly page: number;
  readonly charStart: number | null;
  readonly charEnd: number | null;
  readonly pageOffsetFraction: number | null;
}

export type NavigationOutcome =
  | { readonly kind: 'exact' }
  | { readonly kind: 'approximate' }
  | { readonly kind: 'not-on-page' }
  | { readonly kind: 'document-unavailable' };

export interface OccurrenceHighlight {
  readonly pageNumber: number;
  readonly start: number;
  readonly end: number;
  readonly approximate: boolean;
}

export interface OccurrenceNavigationOptions {
  readonly target: OccurrenceTarget | null;
  readonly documentId: string | null;
  /** True once the reader has given up trying to open a document. */
  readonly documentFailed: boolean;
  readonly registry: PageRegistry;
  /** Reopens a document by its content identity. */
  readonly openDocument: (documentId: string) => Promise<void>;
  /** Scrolls to a page, using the stored offset as a hint. */
  readonly goToPlace: (page: number, pageOffsetFraction: number | null) => void;
  readonly onOutcome: (outcome: NavigationOutcome) => void;
}

export interface OccurrenceNavigation {
  readonly highlight: OccurrenceHighlight | null;
  readonly clear: () => void;
}

export const useOccurrenceNavigation = ({
  target,
  documentId,
  documentFailed,
  registry,
  openDocument,
  goToPlace,
  onOutcome,
}: OccurrenceNavigationOptions): OccurrenceNavigation => {
  const reported = useRef<string | null>(null);
  const requestedOpen = useRef<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  // Pages appearing and disappearing is what finishes this journey, so the
  // hook re-renders with the live set rather than polling for it.
  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry]);
  const readVersion = useCallback(() => registry.version(), [registry]);
  const liveVersion = useSyncExternalStore(subscribe, readVersion);

  const key = target === null ? null : `${target.itemId}:${String(target.page)}`;

  /**
   * Where the word is now, worked out during render.
   *
   * Derived rather than stored: it is a function of the target and the
   * page that is actually on screen, and a stored copy could outlive
   * either of them for a frame.
   */
  const located = useMemo(() => {
    void liveVersion;

    if (target === null || documentId === null || documentId !== target.documentId) {
      return null;
    }

    const live = registry.get(target.page);

    if (live === null) {
      return null;
    }

    return locateSavedWord(
      joinSegments(live.layer.segments).text,
      target.normalized,
      target.charStart,
      target.charEnd,
    );
  }, [documentId, liveVersion, registry, target]);

  const highlight: OccurrenceHighlight | null =
    target === null || located === null || located.kind === 'not-found' || dismissed === key
      ? null
      : {
          pageNumber: target.page,
          start: located.start,
          end: located.end,
          approximate: located.kind === 'approximate',
        };

  useEffect(() => {
    if (target === null || key === null || reported.current === key) {
      return;
    }

    // Step one: the right document, asked for by identity so the main
    // process decides which file that is.
    if (documentId !== target.documentId) {
      if (documentFailed) {
        reported.current = key;
        onOutcome({ kind: 'document-unavailable' });

        return;
      }

      if (requestedOpen.current !== key) {
        requestedOpen.current = key;
        void openDocument(target.documentId);
      }

      return;
    }

    // Step two: the page, with the stored fraction as a scroll hint. The
    // reader's remembered position is not touched by arriving here.
    goToPlace(target.page, target.pageOffsetFraction);

    // Step three: the page has to be on screen before there is any text to
    // check, so nothing is decided until it is.
    if (located === null) {
      return;
    }

    // Step four: say honestly which of the three things happened.
    reported.current = key;
    onOutcome(
      located.kind === 'not-found'
        ? { kind: 'not-on-page' }
        : { kind: located.kind === 'exact' ? 'exact' : 'approximate' },
    );
  }, [documentFailed, documentId, goToPlace, key, located, onOutcome, openDocument, target]);

  const clear = useCallback((): void => {
    setDismissed(key);
  }, [key]);

  return { highlight, clear };
};
