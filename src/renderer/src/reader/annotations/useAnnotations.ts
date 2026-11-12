import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addHighlight,
  EMPTY_ANNOTATIONS,
  removeHighlight,
  rotateBy,
  toggleBookmark,
  updateHighlight,
  type AnnotationsExportOutcome,
  type DocumentAnnotations,
  type HighlightColour,
} from '@core/annotations/annotations';
import type { DesktopBridge } from '@shared/ipc/contracts';

/**
 * The open book's highlights, notes, bookmarks and rotation.
 *
 * Read once when a book opens, changed in memory, and written back a
 * moment after each change — a moment, so that typing a note is one write
 * and not one per letter. A change still waiting when the book is closed
 * or swapped is written then, for the book it belongs to.
 *
 * Without a bridge (a test, or a build with nowhere to keep them) the
 * annotations simply last as long as the book is open.
 */
const WRITE_DELAY = 400;

export interface NewSelection {
  readonly page: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface AnnotationControls {
  readonly annotations: DocumentAnnotations;
  /** Highlights every part of a selection; returns the id of the first. */
  readonly highlight: (parts: readonly NewSelection[], colour: HighlightColour) => string | null;
  readonly recolour: (id: string, colour: HighlightColour) => void;
  readonly setNote: (id: string, note: string) => void;
  readonly remove: (id: string) => void;
  readonly toggleBookmark: (page: number, label: string) => void;
  readonly rotate: (quarterTurns: number) => void;
  /** True after a change could not be written to disk. */
  readonly writeFailed: boolean;
  /** Writes this book's highlights, notes and bookmarks to a file the reader chooses. */
  readonly exportDocument?: () => Promise<AnnotationsExportOutcome>;
}

const newId = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

interface Loaded {
  readonly documentId: string | null;
  readonly annotations: DocumentAnnotations;
}

export const useAnnotations = (
  bridge: DesktopBridge | null,
  documentId: string | null,
  documentName: string,
): AnnotationControls => {
  const store = bridge?.annotations;
  const [loaded, setLoaded] = useState<Loaded>({
    documentId: null,
    annotations: EMPTY_ANNOTATIONS,
  });
  const [writeFailed, setWriteFailed] = useState(false);

  // What is waiting to be written, and for which book.
  const pending = useRef<{
    readonly documentId: string;
    readonly name: string;
    readonly annotations: DocumentAnnotations;
  } | null>(null);
  const timer = useRef<number | null>(null);

  const flush = useCallback((): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }

    const waiting = pending.current;

    pending.current = null;

    if (waiting === null || store === undefined) {
      return;
    }

    void store.save(waiting.documentId, waiting.name, waiting.annotations).then(
      (written) => {
        setWriteFailed(!written);
      },
      () => {
        setWriteFailed(true);
      },
    );
  }, [store]);

  useEffect(() => {
    if (documentId === null) {
      return undefined;
    }

    let current = true;

    if (store !== undefined) {
      void store.load(documentId).then(
        (annotations) => {
          if (current) {
            setLoaded({ documentId, annotations });
          }
        },
        () => undefined,
      );
    }

    return (): void => {
      current = false;
      // The book is going away: whatever is waiting is written now.
      flush();
    };
  }, [documentId, store, flush]);

  // A set read for another book is never shown for this one.
  const annotations = loaded.documentId === documentId ? loaded.annotations : EMPTY_ANNOTATIONS;

  const change = useCallback(
    (apply: (current: DocumentAnnotations) => DocumentAnnotations): void => {
      if (documentId === null) {
        return;
      }

      setLoaded((current) => {
        const before = current.documentId === documentId ? current.annotations : EMPTY_ANNOTATIONS;
        const after = apply(before);

        if (after === before) {
          return current;
        }

        pending.current = { documentId, name: documentName, annotations: after };

        if (timer.current !== null) {
          window.clearTimeout(timer.current);
        }

        timer.current = window.setTimeout(flush, WRITE_DELAY);

        return { documentId, annotations: after };
      });
    },
    [documentId, documentName, flush],
  );

  const highlight = useCallback(
    (parts: readonly NewSelection[], colour: HighlightColour): string | null => {
      const ids = parts.map(newId);
      const at = new Date().toISOString();

      change((current) =>
        parts.reduce(
          (next, part, index) =>
            addHighlight(next, { ...part, id: ids[index] ?? newId(), colour, at }),
          current,
        ),
      );

      return ids[0] ?? null;
    },
    [change],
  );

  const recolour = useCallback(
    (id: string, colour: HighlightColour): void => {
      change((current) => updateHighlight(current, id, { colour }));
    },
    [change],
  );

  const setNote = useCallback(
    (id: string, note: string): void => {
      change((current) => updateHighlight(current, id, { note }));
    },
    [change],
  );

  const remove = useCallback(
    (id: string): void => {
      change((current) => removeHighlight(current, id));
    },
    [change],
  );

  const toggle = useCallback(
    (page: number, label: string): void => {
      change((current) => toggleBookmark(current, page, label, new Date().toISOString()));
    },
    [change],
  );

  const rotate = useCallback(
    (quarterTurns: number): void => {
      change((current) => ({ ...current, rotation: rotateBy(current.rotation, quarterTurns) }));
    },
    [change],
  );

  const exportDocument = useMemo(
    () =>
      store === undefined || documentId === null
        ? undefined
        : (): Promise<AnnotationsExportOutcome> => {
            // What was typed a moment ago is written before the file is.
            flush();

            return store.exportDocument(documentId);
          },
    [store, documentId, flush],
  );

  return {
    annotations,
    highlight,
    recolour,
    setNote,
    remove,
    toggleBookmark: toggle,
    rotate,
    writeFailed,
    ...(exportDocument === undefined ? {} : { exportDocument }),
  };
};
