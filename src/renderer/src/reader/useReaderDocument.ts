import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ReadingPosition, ZoomState } from '@core/persistence/types';
import type { OpenedPdf, PdfEngine } from '@core/pdf/pdfEngine';
import type { DesktopBridge, DocumentPayload, DocumentRequestResult } from '@shared/ipc/contracts';

import { describeDocumentFailure } from './documentFailure';
import { measureChapter } from './epub/EpubPageSurface';
import { openEpub } from './epub/epubDocument';
import { looksLikeZip } from './epub/zip';
import { createRendererPdfEngine } from './pdf/rendererEngine';

/**
 * Owns the opened document.
 *
 * The state machine is deliberately explicit: every outcome the user can see
 * (nothing open, loading, open, password needed, failed) is a named state, so
 * no screen has to infer what is going on from a pile of booleans.
 *
 * Two things were added in Milestone 2, both about documents arriving late:
 *
 * - every load carries a **request number**. A document that finishes opening
 *   after the reader has moved on is closed and discarded instead of being
 *   shown, so switching documents while one is loading cannot leave the
 *   application displaying the wrong one;
 * - a load can be **cancelled**, and reports progress while it runs, because
 *   a large document takes long enough that a reader may change their mind.
 */

export interface LoadProgress {
  readonly loaded: number;
  /** 0 until the engine knows the size. */
  readonly total: number;
}

export type ReaderState =
  | { readonly status: 'empty' }
  | { readonly status: 'loading'; readonly name: string; readonly progress: LoadProgress }
  | {
      readonly status: 'ready';
      /**
       * Distinguishes one open from the next, including reopening the same
       * document in the same session. Anything that happens once per open —
       * restoring the reading position, for instance — keys off this rather
       * than off the document id, which repeats.
       */
      readonly openToken: number;
      readonly documentId: string;
      readonly name: string;
      readonly document: OpenedPdf;
      readonly pageCount: number;
      readonly loadMilliseconds: number;
      /** Where this document was left last time, if it has been read before. */
      readonly restored: ReadingPosition | null;
      /**
       * The zoom in use before this document was opened, as the main
       * process read it from the reader state (ADR-031). It travels with
       * the open so that `defaultZoomMode: 'last-used'` cannot be answered
       * with this document's own freshly recorded position.
       */
      readonly lastUsedZoom: ZoomState | null;
    }
  | { readonly status: 'password'; readonly name: string; readonly message: string }
  | {
      readonly status: 'failed';
      readonly name: string;
      readonly message: string;
      /** Engine wording, shown as developer instrumentation, never as product copy. */
      readonly cause?: string;
    };

export interface ReaderControls {
  readonly state: ReaderState;
  readonly openDialog: () => Promise<void>;
  readonly openRecent: (documentId: string) => Promise<void>;
  readonly submitPassword: (password: string) => Promise<void>;
  /** Stops an in-flight open. */
  readonly cancel: () => void;
  /** Closes the current document and returns to the start screen. */
  readonly close: () => Promise<void>;
}

const NO_PROGRESS: LoadProgress = { loaded: 0, total: 0 };

export const useReaderDocument = (bridge: DesktopBridge | null): ReaderControls => {
  const engine = useMemo<PdfEngine>(() => createRendererPdfEngine(), []);
  const [state, setState] = useState<ReaderState>({ status: 'empty' });

  /** The payload awaiting a password, kept so the retry has the same bytes. */
  const pending = useRef<DocumentPayload | null>(null);
  const openDocument = useRef<OpenedPdf | null>(null);
  const requests = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(
    async (payload: DocumentPayload, password?: string): Promise<void> => {
      const request = requests.current + 1;
      requests.current = request;

      controller.current?.abort();
      const abortController = new AbortController();
      controller.current = abortController;

      pending.current = payload;
      setState({ status: 'loading', name: payload.name, progress: NO_PROGRESS });

      const previous = openDocument.current;
      openDocument.current = null;
      await previous?.close();

      const started = performance.now();
      // An EPUB is a zip archive, and says so in its first bytes; a PDF never does.
      const result = looksLikeZip(payload.bytes)
        ? await openEpub(payload.bytes, payload.name, { measure: measureChapter })
        : await engine.open({
            bytes: payload.bytes,
            label: payload.name,
            signal: abortController.signal,
            onProgress: ({ loaded, total }) => {
              if (requests.current === request) {
                setState((current) =>
                  current.status === 'loading'
                    ? { ...current, progress: { loaded, total } }
                    : current,
                );
              }
            },
            ...(password === undefined ? {} : { password }),
          });
      const loadMilliseconds = Math.round(performance.now() - started);

      // Another document was requested while this one was opening. The late
      // arrival is closed rather than shown: it is not what the reader is
      // looking at any more.
      if (requests.current !== request) {
        if (result.ok) {
          await result.value.close();
        }
        return;
      }

      if (result.ok) {
        openDocument.current = result.value;
        setState({
          status: 'ready',
          openToken: request,
          documentId: payload.id,
          name: payload.name,
          document: result.value,
          pageCount: result.value.pageCount,
          loadMilliseconds,
          restored: payload.position,
          lastUsedZoom: payload.lastUsedZoom ?? null,
        });
        return;
      }

      const { kind, message, cause } = result.error;

      if (kind === 'cancelled') {
        setState({ status: 'empty' });
        return;
      }

      setState(
        kind === 'password-required' || kind === 'password-incorrect'
          ? { status: 'password', name: payload.name, message }
          : { status: 'failed', name: payload.name, message, cause },
      );
    },
    [engine],
  );

  /**
   * Shows the outcome of a document the reader *asked for* (M7.2).
   *
   * Every explicit request goes through here: the file chooser, a recent
   * entry, the document named on the command line. A failure becomes one
   * sentence composed from the closed reason code — the main process no
   * longer sends words, so there is nothing here to pass through.
   */
  const accept = useCallback(
    async (result: DocumentRequestResult): Promise<void> => {
      if (result.status === 'opened') {
        await load(result.document);
      } else if (result.status === 'unreadable') {
        setState({
          status: 'failed',
          name: result.name ?? '',
          message: describeDocumentFailure(result),
        });
      }
    },
    [load],
  );

  const withBridge = useCallback(
    async (use: (ready: DesktopBridge) => Promise<void>): Promise<void> => {
      if (bridge === null) {
        setState({
          status: 'failed',
          name: '',
          message: 'The desktop bridge is unavailable, so no document can be opened.',
        });
        return;
      }

      await use(bridge);
    },
    [bridge],
  );

  const openDialog = useCallback(
    async (): Promise<void> =>
      withBridge(async (ready) => {
        await accept(await ready.openDocumentDialog());
      }),
    [accept, withBridge],
  );

  const openRecent = useCallback(
    async (documentId: string): Promise<void> =>
      withBridge(async (ready) => {
        await accept(await ready.openRecentDocument(documentId));
      }),
    [accept, withBridge],
  );

  const submitPassword = useCallback(
    async (password: string): Promise<void> => {
      const payload = pending.current;

      if (payload !== null) {
        await load(payload, password);
      }
    },
    [load],
  );

  const cancel = useCallback((): void => {
    controller.current?.abort();
  }, []);

  const close = useCallback(async (): Promise<void> => {
    requests.current += 1;
    controller.current?.abort();

    const previous = openDocument.current;
    openDocument.current = null;
    pending.current = null;

    setState({ status: 'empty' });
    await previous?.close();
  }, []);

  /**
   * What to show on launch: the document named on the command line if there
   * was one, otherwise the document that was open last time.
   */
  useEffect(() => {
    if (bridge === null) {
      return;
    }

    let cancelled = false;

    const restore = async (): Promise<void> => {
      const initial = await bridge.getInitialDocument();

      if (cancelled) {
        return;
      }

      if (initial.status === 'opened') {
        await load(initial.document);
        return;
      }

      /*
       * An explicit request that failed is reported, and the session
       * stops here (M7.2, R3).
       *
       * This is the line the distinction lives on. A document named on
       * the command line is something the reader asked for by
       * double-clicking a file, by "open with", or by typing it: going
       * quietly to the start screen — or, worse, opening a *different*
       * document from the last session — answers a question they did not
       * ask. `status: 'none'` is not this case: it means no document was
       * named, which is how the application is usually launched.
       */
      if (initial.status === 'unreadable') {
        await accept(initial);
        return;
      }

      const snapshot = await bridge.getReaderState();

      if (cancelled || snapshot.lastDocumentId === null) {
        return;
      }

      const reopened = await bridge.openRecentDocument(snapshot.lastDocumentId);

      /*
       * The other half of the distinction: a silent restore stays silent.
       *
       * Nobody asked for this document in this session — the application
       * is offering it because it was open last time. A file that has
       * since been moved or deleted is ordinary, and turning the start
       * screen into a failure the reader cannot act on would be alarming
       * about something they did not do. The main process has already
       * dropped the entry from the recent list, which is the honest,
       * silent consequence (M7.2, R3).
       */
      if (!cancelled && reopened.status === 'opened') {
        await load(reopened.document);
      }
    };

    void restore().catch(() => undefined);

    return (): void => {
      cancelled = true;
    };
  }, [accept, bridge, load]);

  // Closing the document when the reader goes away releases the PDF.js
  // worker's page cache; without it a reload would leak a whole document.
  useEffect(
    () => (): void => {
      void openDocument.current?.close();
      openDocument.current = null;
    },
    [],
  );

  return { state, openDialog, openRecent, submitPassword, cancel, close };
};
