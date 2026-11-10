import { err, ok } from '@core/result';
import { buildSaveRequest } from '@core/vocabulary/identity';
import { UNKNOWN_TRANSFORM_VERSION } from '@core/vocabulary/snapshot';
import type {
  SavedDocumentFacts,
  SavedOccurrence,
  SavedWord,
  SavedWordState,
} from '@core/vocabulary/types';
import { normalizeWord } from '@core/word/normalizeWord';
import { IpcChannel } from '@shared/ipc/channels';
import {
  parseItemId,
  parseLibraryQuery,
  parseSaveWordRequest,
  parseSearchQuery,
  parseStateForWordRequest,
  type LibraryIpcPage,
  type SearchIpcResults,
  type VocabularyIpcResult,
} from '@shared/ipc/vocabularyContracts';

import type { VocabularyService } from '../vocabulary/vocabularyService';

import { createSenderGuard, type IpcHandlerRegistrar, type IpcInvokeListener } from './senderGuard';

/**
 * The vocabulary channels.
 *
 * Every handler does the same four things in the same order: the sender is
 * checked, the request is parsed, the service is asked, and a typed result
 * goes back. Nothing in between improvises.
 *
 * Two things the renderer cannot do through this surface, by construction:
 *
 * - **Name a file.** A save carries a document *id*; the name, the path and
 *   the size are looked up in the main process. There is no field in any
 *   request that could hold a path.
 * - **Decide what a word is.** The identity of a saved word is recomputed
 *   here from the raw characters with the same function the lookup used, so
 *   a renderer cannot save one word under another word's name — and asking
 *   whether a word is already saved goes through that same normaliser, so a
 *   read cannot be answered for a spelling the store never uses.
 */

export interface VocabularyIpcOptions {
  readonly service: VocabularyService;
  /** Document facts from the main process's own records, by id. */
  readonly describeDocument: (documentId: string) => Promise<SavedDocumentFacts | null>;
  /** The dictionary build a snapshot came from. */
  readonly transformVersion: () => string | null;
  /** Reported when the renderer sends something malformed. */
  readonly onRejected: (message: string) => void;
  /**
   * Called after a save succeeded, with the place it was saved from.
   *
   * This is how an explanation the reader already has in front of them
   * becomes durable: a consequence of the save they asked for, never a
   * cause of one. It runs after the write, so it can never make a save
   * fail.
   */
  readonly afterSave?: (saved: SavedWord, place: { documentId: string; page: number }) => void;
  /** Origin of the Vite dev server, or `null` in production. */
  readonly devServerOrigin: string | null;
  /** Database readiness boundary; omitted only by isolated unit tests. */
  readonly ensureReady?: () => Promise<unknown>;
  readonly enterOperation?: () => (() => void) | null;
}

const INVALID = err({ kind: 'invalid-request' } as const);

export const registerVocabularyIpcHandlers = (
  ipc: IpcHandlerRegistrar,
  {
    service,
    describeDocument,
    transformVersion,
    onRejected,
    devServerOrigin,
    afterSave,
    ensureReady = async (): Promise<void> => {},
    enterOperation = () => (): void => {},
  }: VocabularyIpcOptions,
): void => {
  const guard = createSenderGuard(devServerOrigin);
  type Handler = (...args: unknown[]) => unknown;
  const readyGuard = (channel: string, handler: Handler): IpcInvokeListener =>
    guard(channel, async (...args: unknown[]): Promise<unknown> => {
      const release = enterOperation();
      if (release === null)
        return err({ kind: 'unavailable', reason: 'recovery-required' } as const);
      try {
        await ensureReady();
        return await handler(...args);
      } catch {
        return err({ kind: 'unavailable', reason: 'unknown' } as const);
      } finally {
        release();
      }
    });

  const reject = <T>(message: string): VocabularyIpcResult<T> => {
    onRejected(message);

    return INVALID;
  };

  ipc.handle(
    IpcChannel.VocabularyStateForWord,
    guard(
      IpcChannel.VocabularyStateForWord,
      (raw: unknown): VocabularyIpcResult<SavedWordState> => {
        const request = parseStateForWordRequest(raw);

        if (request === null) {
          return reject('a malformed vocabulary state request was ignored');
        }

        // The identity of a saved word is decided here, not by the sender:
        // the word arrives as characters and is put through the same
        // normaliser the lookup and the save path use. A renderer that asks
        // about `Mice ` therefore gets the answer for `mice`, and cannot be
        // told that a word it holds is unsaved because its spelling of the
        // identity differed from the stored one.
        const normalized = normalizeWord(request.normalized);

        if (normalized.length === 0) {
          // Nothing that normalises away can ever have been saved, so there
          // is no question here for the store to answer.
          return reject('a vocabulary state request for an empty word was ignored');
        }

        return service.stateForWord(normalized, request.documentId, request.page);
      },
    ),
  );

  ipc.handle(
    IpcChannel.VocabularySave,
    guard(
      IpcChannel.VocabularySave,
      async (raw: unknown): Promise<VocabularyIpcResult<SavedWord>> => {
        const request = parseSaveWordRequest(raw);

        if (request === null) {
          return reject('a malformed save request was ignored');
        }

        const known = await describeDocument(request.documentId);

        if (known === null) {
          // The renderer may only save from a document this process opened.
          return reject('a save for an unknown document was ignored');
        }

        const saveRequest = buildSaveRequest(
          { ...request.word, start: 0, end: request.word.raw.length },
          request.result,
          { ...known, pageCount: known.pageCount ?? request.pageCount },
          request.occurrence,
          transformVersion() ?? UNKNOWN_TRANSFORM_VERSION,
        );

        if (saveRequest === null) {
          // Nothing was shown, so there is nothing to preserve.
          return reject('a save with no dictionary answer was ignored');
        }

        const saved = service.save(saveRequest);

        if (saved.ok && afterSave !== undefined) {
          afterSave(saved.value, {
            documentId: request.documentId,
            page: request.occurrence.page,
          });
        }

        return saved;
      },
    ),
  );

  ipc.handle(
    IpcChannel.VocabularyRemove,
    readyGuard(IpcChannel.VocabularyRemove, (raw: unknown): VocabularyIpcResult<null> => {
      const itemId = parseItemId(raw);

      if (itemId === null) {
        return reject('a malformed remove request was ignored');
      }

      const result = service.remove(itemId);

      return result.ok ? ok(null) : result;
    }),
  );

  ipc.handle(
    IpcChannel.VocabularyRestore,
    readyGuard(IpcChannel.VocabularyRestore, (raw: unknown): VocabularyIpcResult<null> => {
      const itemId = parseItemId(raw);

      if (itemId === null) {
        return reject('a malformed restore request was ignored');
      }

      const result = service.restore(itemId);

      return result.ok ? ok(null) : result;
    }),
  );

  ipc.handle(
    IpcChannel.VocabularyList,
    readyGuard(IpcChannel.VocabularyList, (raw: unknown): VocabularyIpcResult<LibraryIpcPage> => {
      const query = parseLibraryQuery(raw);

      if (query === null) {
        return reject('a malformed library request was ignored');
      }

      const page = service.list(query);

      if (!page.ok) {
        return page;
      }

      const documents = service.documents();

      return ok({ ...page.value, documents: documents.ok ? documents.value : [] });
    }),
  );

  ipc.handle(
    IpcChannel.VocabularySearch,
    readyGuard(
      IpcChannel.VocabularySearch,
      (raw: unknown): VocabularyIpcResult<SearchIpcResults> => {
        const query = parseSearchQuery(raw);

        if (query === null) {
          return reject('a malformed vocabulary search was ignored');
        }

        const results = service.search(query);

        if (!results.ok) {
          return results;
        }

        const documents = service.documents();

        return ok({ ...results.value, documents: documents.ok ? documents.value : [] });
      },
    ),
  );

  ipc.handle(
    IpcChannel.VocabularyOccurrences,
    guard(
      IpcChannel.VocabularyOccurrences,
      (raw: unknown): VocabularyIpcResult<readonly SavedOccurrence[]> => {
        const itemId = parseItemId(raw);

        if (itemId === null) {
          return reject('a malformed occurrences request was ignored');
        }

        return service.occurrences(itemId);
      },
    ),
  );
};
