import { err, ok, type Result } from '@core/result';
import type {
  DocumentFilterOption,
  LibraryPage,
  LibraryQuery,
  SaveWordRequest,
  SavedOccurrence,
  SavedWord,
  SavedWordState,
  SearchQuery,
  SearchResults,
  VocabularyFailure,
  VocabularyRepository,
} from '@core/vocabulary/types';

import { VocabularyOpenError, classifyDatabaseError } from './connection';
import type { ExplanationStore, StoredExplanation } from './explanationStore';

/**
 * The vocabulary, as the main process owns it.
 *
 * Shaped after the dictionary service on purpose: it owns the store, opens
 * it lazily and at most once, answers every call with a typed result, and
 * closes cleanly. The differences are the ones the data forces — a
 * vocabulary is written, not just read, so failures here include
 * `write-failed`, and a damaged file is never silently replaced.
 *
 * What this layer guarantees to everything above it:
 *
 * - **Reading survives a broken vocabulary.** The database is not touched
 *   until the reader saves or opens the library. A missing, unwritable or
 *   corrupt file costs a typed failure and nothing else: the document stays
 *   open, the dictionary keeps answering (Principle 7).
 * - **Details stay here.** Driver messages and file paths go to the
 *   main-process diagnostic callback. What crosses the IPC boundary is a
 *   reason code from a closed union.
 * - **Nothing is retried per click.** One failed open is remembered, so a
 *   reader with a read-only profile directory does not pay a filesystem
 *   probe for every word they look at.
 */

export type VocabularyResult<T> = Result<T, VocabularyFailure>;

export interface VocabularyServiceOptions {
  /** Opens the store. Throws `VocabularyOpenError`. */
  readonly open: () => VocabularyRepository;
  /**
   * The explanation store on the **same** connection, when the AI feature
   * is part of the build.
   *
   * Optional, and absent in every Milestone 4 path: without it the service
   * behaves exactly as it did, and removing a word simply has no
   * explanations to capture. With it, remove captures and undo restores
   * them in the same transaction as the word itself (ADR-028).
   */
  readonly openExplanations?: () => ExplanationStore;
  /** Main-process diagnostics. Never crosses the process boundary. */
  readonly onDiagnostic?: (message: string) => void;
}

export interface VocabularyService {
  stateForWord(
    normalized: string,
    documentId: string,
    page: number,
  ): VocabularyResult<SavedWordState>;
  save(request: SaveWordRequest): VocabularyResult<SavedWord>;
  /** Removes a word and keeps it in memory so `restore` can undo it. */
  remove(itemId: string): VocabularyResult<void>;
  /** Puts back the word `remove` last took away, by id. */
  restore(itemId: string): VocabularyResult<void>;
  list(query: LibraryQuery): VocabularyResult<LibraryPage>;
  search(query: SearchQuery): VocabularyResult<SearchResults>;
  occurrences(itemId: string): VocabularyResult<readonly SavedOccurrence[]>;
  documents(): VocabularyResult<readonly DocumentFilterOption[]>;
  close(): void;
}

/**
 * The full story, for the log.
 *
 * `VocabularyOpenError` keeps the driver message and the file it was about
 * in a separate field precisely so that the two can be separated here: the
 * detail goes to the main-process log, the reason goes to the renderer.
 */
const detailOf = (error: unknown): string => {
  if (error instanceof VocabularyOpenError) {
    return `${error.name}: ${error.detail}`;
  }

  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
};

export const createVocabularyService = ({
  open,
  openExplanations,
  onDiagnostic = (): void => {},
}: VocabularyServiceOptions): VocabularyService => {
  let repository: VocabularyRepository | null = null;
  let explanations: ExplanationStore | null = null;
  let failure: VocabularyFailure | null = null;
  let closed = false;
  /**
   * The last word removed, kept for undo.
   *
   * One slot, main-side, deliberately: undo has to put back the original
   * occurrences and the original timestamps, and a renderer holding that
   * data could hand back dates it invented. It is forgotten as soon as it
   * is used, and it is not persisted - closing the application ends the
   * chance to undo, which is what a reader expects of an undo.
   */
  let removed: {
    readonly word: SavedWord;
    readonly explanations: readonly StoredExplanation[];
  } | null = null;

  const store = (): VocabularyRepository | VocabularyFailure => {
    if (closed) {
      return { kind: 'unavailable', reason: 'unknown' };
    }

    if (repository !== null) {
      return repository;
    }

    if (failure !== null) {
      return failure;
    }

    try {
      repository = open();
      // Opened only after the repository, and only when this build has the
      // explanation feature: the two share one connection.
      explanations = openExplanations === undefined ? null : openExplanations();

      return repository;
    } catch (error) {
      const reason =
        error instanceof VocabularyOpenError ? error.reason : classifyDatabaseError(error);

      onDiagnostic(`vocabulary store unavailable (${reason}): ${detailOf(error)}`);
      failure = { kind: 'unavailable', reason };

      return failure;
    }
  };

  /**
   * Runs one operation against the store.
   *
   * A failure to open is reported as it was classified; a failure during
   * the operation is `write-failed` unless it is a reason the reader can
   * act on, because "the save did not happen" is the part that matters to
   * them and the rest belongs in the log.
   */
  const perform = <T>(operation: (store: VocabularyRepository) => T): VocabularyResult<T> => {
    const resolved = store();

    if ('kind' in resolved) {
      return err(resolved);
    }

    try {
      return ok(operation(resolved));
    } catch (error) {
      const reason = classifyDatabaseError(error);

      onDiagnostic(`vocabulary operation failed (${reason}): ${detailOf(error)}`);

      return reason === 'unknown'
        ? err({ kind: 'write-failed' })
        : err({ kind: 'unavailable', reason });
    }
  };

  return {
    stateForWord: (normalized, documentId, page) =>
      perform((active) => active.stateForWord({ normalized, documentId, page })),
    save: (request) => perform((active) => active.save(request)),
    remove: (itemId) =>
      perform((active) => {
        const store = explanations;

        if (store === null) {
          const word = active.find(itemId);

          active.remove(itemId);
          removed = word === null ? null : { word, explanations: [] };

          return;
        }

        // Read before the delete and inside the same transaction, so the
        // capture cannot miss a row or see a half-deleted state. The rows
        // are kept verbatim - ids and timestamps included - because undo
        // must restore the same explanation, not a new one.
        store.transaction(() => {
          const word = active.find(itemId);
          const captured = word === null ? [] : store.listForItem(itemId);

          active.remove(itemId);
          removed = word === null ? null : { word, explanations: captured };
        });
      }),
    restore: (itemId): VocabularyResult<void> => {
      const candidate = removed;

      if (candidate === null || candidate.word.id !== itemId) {
        return err({ kind: 'not-found' });
      }

      const result = perform((active) => {
        const store = explanations;

        if (store === null) {
          active.restore(candidate.word);

          return;
        }

        // One transaction for both halves: the reader never lands in a
        // state where the word came back without its explanations, or
        // where only some of them did.
        store.transaction(() => {
          active.restore(candidate.word);
          store.restoreMany(candidate.explanations);
        });
      });

      if (result.ok) {
        removed = null;
      }

      return result;
    },
    list: (query) => perform((active) => active.list(query)),
    search: (query) => perform((active) => active.search(query)),
    occurrences: (itemId) => perform((active) => active.occurrences(itemId)),
    documents: () => perform((active) => active.documents()),
    close: (): void => {
      closed = true;

      if (repository === null) {
        return;
      }

      try {
        repository.close();
      } catch (error) {
        onDiagnostic(`closing the vocabulary store failed: ${detailOf(error)}`);
      }

      repository = null;
      explanations = null;
    },
  };
};
