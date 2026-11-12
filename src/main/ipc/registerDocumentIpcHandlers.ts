import { IpcChannel } from '@shared/ipc/channels';
import { parseDocumentId, type DocumentRequestResult } from '@shared/ipc/contracts';

import { parseDroppedDocumentPath } from '../documents/initialDocument';
import { createSenderGuard, type IpcHandlerRegistrar } from './senderGuard';

export interface DocumentIpcOptions {
  /** Shows the file chooser and reads the chosen file. */
  readonly chooseDocument: () => Promise<DocumentRequestResult>;
  /** Reads the document named on the command line, if there was one. */
  readonly initialDocument: () => Promise<DocumentRequestResult>;
  /** Reopens a document the application has read before, by id. */
  readonly openRecentDocument: (documentId: string) => Promise<DocumentRequestResult>;
  /**
   * Opens a PDF dropped onto the window, through the same path a document
   * handed over by a second launch takes. Given an absolute `.pdf` path.
   */
  readonly openDroppedDocument: (path: string) => void;
  /** Origin of the Vite dev server, or `null` in production. */
  readonly devServerOrigin: string | null;
}

/**
 * Registers the document channels.
 *
 * The page cannot name a file: it can ask for a chooser to be shown, for
 * the document the application was started with, or for a document it has
 * already been told about by id — and nothing else.
 *
 * The one channel that carries a path is the drop channel, and the page
 * has no function that reaches it. The preload script sends it on its
 * own, from a genuine drop event, with the path Electron reports for the
 * dropped file. What arrives is still treated as untrusted: it must be an
 * absolute path ending in `.pdf`, it selects a file rather than reading
 * one, and the open pipeline then checks that the file really is a PDF.
 */
export const registerDocumentIpcHandlers = (
  ipc: IpcHandlerRegistrar,
  {
    chooseDocument,
    initialDocument,
    openRecentDocument,
    openDroppedDocument,
    devServerOrigin,
  }: DocumentIpcOptions,
): void => {
  const guard = createSenderGuard(devServerOrigin);

  ipc.handle(IpcChannel.OpenDocumentDialog, guard(IpcChannel.OpenDocumentDialog, chooseDocument));
  ipc.handle(IpcChannel.GetInitialDocument, guard(IpcChannel.GetInitialDocument, initialDocument));
  ipc.handle(
    IpcChannel.OpenRecentDocument,
    guard(IpcChannel.OpenRecentDocument, async (rawId: unknown): Promise<DocumentRequestResult> => {
      const documentId = parseDocumentId(rawId);

      /*
       * An id is the renderer's only handle on a file; a malformed one is
       * rejected here rather than looked up. `unknown` is the right word
       * for it: the application cannot say anything about a document it
       * was never able to identify, and the renderer's own bug is not
       * something to explain to a reader (M7.2).
       */
      return documentId === null
        ? { status: 'unreadable', reason: 'unknown', name: null }
        : openRecentDocument(documentId);
    }),
  );
  ipc.handle(
    IpcChannel.OpenDroppedDocument,
    guard(IpcChannel.OpenDroppedDocument, (rawPath: unknown): boolean => {
      const path = parseDroppedDocumentPath(rawPath);

      if (path === null) {
        return false;
      }

      openDroppedDocument(path);

      return true;
    }),
  );
};
