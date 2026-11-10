import { IpcChannel } from '@shared/ipc/channels';
import { parseDocumentId, type DocumentRequestResult } from '@shared/ipc/contracts';

import { createSenderGuard, type IpcHandlerRegistrar } from './senderGuard';

export interface DocumentIpcOptions {
  /** Shows the file chooser and reads the chosen file. */
  readonly chooseDocument: () => Promise<DocumentRequestResult>;
  /** Reads the document named on the command line, if there was one. */
  readonly initialDocument: () => Promise<DocumentRequestResult>;
  /** Reopens a document the application has read before, by id. */
  readonly openRecentDocument: (documentId: string) => Promise<DocumentRequestResult>;
  /** Origin of the Vite dev server, or `null` in production. */
  readonly devServerOrigin: string | null;
}

/**
 * Registers the document channels.
 *
 * None of them takes a path from the renderer: the renderer can ask for a
 * chooser to be shown, for the document the application was started with, or
 * for a document it has already been told about by id — and nothing else.
 * That keeps arbitrary file reads out of reach even if the renderer is
 * compromised.
 */
export const registerDocumentIpcHandlers = (
  ipc: IpcHandlerRegistrar,
  { chooseDocument, initialDocument, openRecentDocument, devServerOrigin }: DocumentIpcOptions,
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
};
