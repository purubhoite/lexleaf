import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { joinSegments } from '@core/word/identifyWord';
import { nextWordFrom, previousWordFrom, wordOnEntry } from '@core/word/wordCursor';

import type { PageRegistry } from './pageRegistry';
import {
  isStaleInteraction,
  resolvePointerInteraction,
  resolveSelectionInteraction,
  resolveTextIndexInteraction,
  type WordInteraction,
} from './resolveInteraction';

/**
 * The reader's current word, however they asked for it.
 *
 * All three routes — pointer, selection, keyboard — produce the same
 * `WordInteraction`, and all three go through the same core identification.
 * The hook adds the two things a *live* reader needs that a pure function
 * cannot provide:
 *
 * - **staleness**: when the page that produced an answer is recycled or
 *   re-rendered, the answer disappears. A word belonging to a layer that no
 *   longer exists is the one thing this subsystem must never show;
 * - **continuity for the keyboard**: moving past the end of a page scrolls
 *   to the next one and continues there once it has rendered.
 */

export interface KeyboardCursor {
  readonly pageNumber: number;
  /** Index in the joined text of that page. */
  readonly index: number;
}

export interface WordInteractionOptions {
  readonly registry: PageRegistry;
  readonly documentId: string | null;
  /** Page the reader is on, used as the keyboard cursor's starting point. */
  readonly currentPage: number;
  readonly pageCount: number;
  /** Brings a page into view so the keyboard cursor can continue onto it. */
  readonly revealPage: (pageNumber: number) => void;
}

export interface WordInteractionControls {
  readonly interaction: WordInteraction | null;
  /** True once the reader has tried at least once, so "nothing" can be explained. */
  readonly interacted: boolean;
  readonly cursor: KeyboardCursor | null;
  readonly handlePointerDown: (event: { clientX: number; clientY: number }) => void;
  /** Returns the interaction it resolved, so a caller can act on it at once. */
  readonly handleSelectionChanged: () => WordInteraction | null;
  readonly moveCursor: (direction: 'forward' | 'backward') => void;
  readonly clear: () => void;
}

interface PendingEntry {
  readonly pageNumber: number;
  readonly direction: 'forward' | 'backward';
}

const textOf = (segments: Parameters<typeof joinSegments>[0]): string =>
  joinSegments(segments).text;

/**
 * The interaction if it still refers to a live page, otherwise nothing.
 *
 * `atVersion` is the registry version the answer is valid as of: the
 * registry is mutable, so the version is what tells React the result has to
 * be recomputed.
 */
const liveOnly = (
  interaction: WordInteraction | null,
  registry: PageRegistry,
  documentId: string | null,
  atVersion: number,
): WordInteraction | null => {
  void atVersion;

  return interaction !== null && !isStaleInteraction(interaction, registry, documentId)
    ? interaction
    : null;
};

export const useWordInteraction = ({
  registry,
  documentId,
  currentPage,
  pageCount,
  revealPage,
}: WordInteractionOptions): WordInteractionControls => {
  const [interaction, setInteraction] = useState<WordInteraction | null>(null);
  const [interacted, setInteracted] = useState(false);
  const [cursor, setCursor] = useState<KeyboardCursor | null>(null);
  const [pending, setPending] = useState<PendingEntry | null>(null);

  // Re-runs the effects below whenever the set of live pages changes.
  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry]);
  const readVersion = useCallback(() => registry.version(), [registry]);
  const liveVersion = useSyncExternalStore(subscribe, readVersion);

  const clear = useCallback((): void => {
    setInteraction(null);
    setCursor(null);
    setPending(null);
    setInteracted(false);
  }, []);

  // A different document shares nothing with the previous one. Adjusting
  // during render (rather than in an effect) means no frame is ever painted
  // with the old document's word still in the panel.
  const [shownDocument, setShownDocument] = useState(documentId);

  if (shownDocument !== documentId) {
    setShownDocument(documentId);
    setInteraction(null);
    setCursor(null);
    setPending(null);
    setInteracted(false);
  }

  // An answer whose page has been recycled or re-rendered is not shown.
  // `liveVersion` re-renders this hook whenever the live set changes, so
  // this is a derivation rather than stored state that has to be cleaned up.
  const liveInteraction = useMemo(
    () => liveOnly(interaction, registry, documentId, liveVersion),
    [interaction, registry, documentId, liveVersion],
  );

  // Continues a keyboard walk onto a page that has just become live. The
  // registry is an external store, so the work happens in its subscription
  // callback; the immediate attempt covers a page that became live between
  // the request and this subscription.
  useEffect(() => {
    if (pending === null) {
      return;
    }

    const advance = (): void => {
      const page = registry.get(pending.pageNumber);

      if (page === null) {
        return;
      }

      const span = wordOnEntry(textOf(page.layer.segments), pending.direction);

      if (span === null) {
        // A page with no text at all: keep walking in the same direction.
        const nextPage = pending.pageNumber + (pending.direction === 'forward' ? 1 : -1);

        if (nextPage >= 1 && nextPage <= pageCount) {
          setPending({ pageNumber: nextPage, direction: pending.direction });
          revealPage(nextPage);
        } else {
          setPending(null);
        }
        return;
      }

      setPending(null);
      setCursor({ pageNumber: page.pageNumber, index: span.start });
      setInteraction(resolveTextIndexInteraction(page, span.start, 'keyboard'));
    };

    const unsubscribe = registry.subscribe(advance);

    advance();

    return unsubscribe;
  }, [pending, registry, pageCount, revealPage]);

  const handlePointerDown = useCallback(
    (event: { clientX: number; clientY: number }): void => {
      setInteracted(true);
      setCursor(null);
      setPending(null);
      setInteraction(resolvePointerInteraction(document, registry, event));
    },
    [registry],
  );

  const handleSelectionChanged = useCallback((): WordInteraction | null => {
    const selection = window.getSelection();

    if (selection === null || selection.isCollapsed || selection.anchorNode === null) {
      return null;
    }

    const resolved = resolveSelectionInteraction(
      {
        node: selection.anchorNode,
        offset: selection.anchorOffset,
        isCollapsed: selection.isCollapsed,
      },
      registry,
    );

    if (resolved !== null) {
      setInteracted(true);
      setInteraction(resolved);
    }

    return resolved;
  }, [registry]);

  const moveCursor = useCallback(
    (direction: 'forward' | 'backward'): void => {
      setInteracted(true);

      const startPage = cursor?.pageNumber ?? currentPage;
      const page = registry.get(startPage);

      if (page === null) {
        // The cursor's page is not rendered yet; show it and enter it when
        // it is.
        revealPage(startPage);
        setPending({ pageNumber: startPage, direction });
        return;
      }

      const text = textOf(page.layer.segments);

      if (cursor === null) {
        const entry = wordOnEntry(text, direction);

        if (entry !== null) {
          setCursor({ pageNumber: startPage, index: entry.start });
          setInteraction(resolveTextIndexInteraction(page, entry.start, 'keyboard'));
          return;
        }
      }

      const span =
        cursor === null
          ? null
          : direction === 'forward'
            ? nextWordFrom(text, cursor.index)
            : previousWordFrom(text, cursor.index);

      if (span !== null) {
        setCursor({ pageNumber: startPage, index: span.start });
        setInteraction(resolveTextIndexInteraction(page, span.start, 'keyboard'));
        return;
      }

      const nextPage = startPage + (direction === 'forward' ? 1 : -1);

      if (nextPage < 1 || nextPage > pageCount) {
        return;
      }

      revealPage(nextPage);
      setPending({ pageNumber: nextPage, direction });
    },
    [cursor, currentPage, pageCount, registry, revealPage],
  );

  return {
    interaction: liveInteraction,
    interacted,
    cursor,
    handlePointerDown,
    handleSelectionChanged,
    moveCursor,
    clear,
  };
};
