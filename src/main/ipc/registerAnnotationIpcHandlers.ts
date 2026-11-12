import {
  EMPTY_ANNOTATIONS,
  type AnnotationsExportOutcome,
  type DocumentAnnotations,
} from '@core/annotations/annotations';
import { IpcChannel } from '@shared/ipc/channels';

import { isDocumentId, type AnnotationStore } from '../annotations/annotationStore';

import { createSenderGuard, type IpcHandlerRegistrar } from './senderGuard';

/**
 * Highlights, notes and bookmarks, as the window asks for them.
 *
 * Three channels. The window names a document by its identity and sends,
 * at most, that document's annotations; it never names a file. What it
 * sends is parsed by the store before anything is kept, and the export
 * writes from the store, to a place the reader picks in the system's own
 * save window.
 */
export interface AnnotationIpcOptions {
  readonly store: AnnotationStore;
  readonly exportDocument: (documentId: string) => Promise<AnnotationsExportOutcome>;
  readonly devServerOrigin: string | null;
}

export const registerAnnotationIpcHandlers = (
  ipc: IpcHandlerRegistrar,
  { store, exportDocument, devServerOrigin }: AnnotationIpcOptions,
): void => {
  const guard = createSenderGuard(devServerOrigin);

  ipc.handle(
    IpcChannel.AnnotationsLoad,
    guard(IpcChannel.AnnotationsLoad, async (documentId: unknown): Promise<DocumentAnnotations> => {
      if (!isDocumentId(documentId)) {
        return EMPTY_ANNOTATIONS;
      }

      try {
        return await store.load(documentId);
      } catch {
        return EMPTY_ANNOTATIONS;
      }
    }),
  );

  ipc.handle(
    IpcChannel.AnnotationsSave,
    guard(
      IpcChannel.AnnotationsSave,
      async (documentId: unknown, name: unknown, annotations: unknown): Promise<boolean> => {
        if (!isDocumentId(documentId) || typeof name !== 'string') {
          return false;
        }

        try {
          return await store.save(documentId, name, annotations);
        } catch {
          return false;
        }
      },
    ),
  );

  ipc.handle(
    IpcChannel.AnnotationsExport,
    guard(
      IpcChannel.AnnotationsExport,
      async (documentId: unknown): Promise<AnnotationsExportOutcome> => {
        if (!isDocumentId(documentId)) {
          return { status: 'failed' };
        }

        return exportDocument(documentId);
      },
    ),
  );
};
