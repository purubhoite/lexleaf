import { DEFAULT_PREFERENCES, type Preferences } from './preferences';
import {
  START_OF_DOCUMENT,
  type DocumentRecord,
  type ReaderState,
  type ReadingPosition,
  type ZoomState,
} from './types';

/**
 * Pure operations on the remembered reading state.
 *
 * Nothing here touches a disk, a database or Electron: the store that owns
 * the file applies these functions and persists the result (ADR-016). That is
 * what makes the rules — ordering, bounded history, unknown ids — testable
 * without any I/O, and what will let Milestone 4 change the storage medium
 * without rewriting the rules.
 */

/**
 * Version 2 adds the `preferences` block and nothing else (ADR-031).
 *
 * The migration from 1 is additive — a v1 document keeps every reading
 * position, every recent entry and their order, and gains the defaults —
 * and the bump is what stops an older build from silently dropping the
 * block on its next write. The cost is recorded in ADR-031: an older build
 * reading a v2 file quarantines it.
 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * How many documents the recent list keeps.
 *
 * Bounded on purpose: an unbounded list is a slowly growing file, a slowly
 * growing privacy record, and a menu nobody can use.
 */
export const RECENT_DOCUMENT_LIMIT = 20;

export const emptyReaderState = (): ReaderState => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  documents: [],
  preferences: DEFAULT_PREFERENCES,
});

export interface OpenedDocumentFacts {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly pageCount: number | null;
  /** ISO 8601. */
  readonly at: string;
}

export const findDocument = (state: ReaderState, id: string): DocumentRecord | null =>
  state.documents.find((document) => document.id === id) ?? null;

/** The document to offer on launch, or `null` when nothing has been read yet. */
export const lastOpenedDocument = (state: ReaderState): DocumentRecord | null =>
  state.documents[0] ?? null;

/**
 * Records a successful open.
 *
 * An id already present keeps its reading position — the point of the record
 * — while its path and name are refreshed, because the same document may have
 * been moved or renamed since it was last read. The entry moves to the front,
 * and the list is trimmed from the back.
 */
export const rememberOpen = (state: ReaderState, facts: OpenedDocumentFacts): ReaderState => {
  const existing = findDocument(state, facts.id);

  const record: DocumentRecord = {
    id: facts.id,
    path: facts.path,
    name: facts.name,
    sizeBytes: facts.sizeBytes,
    pageCount: facts.pageCount ?? existing?.pageCount ?? null,
    position: existing?.position ?? START_OF_DOCUMENT,
    lastOpenedAt: facts.at,
  };

  const others = state.documents.filter((document) => document.id !== facts.id);

  return {
    ...state,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    documents: [record, ...others].slice(0, RECENT_DOCUMENT_LIMIT),
  };
};

/**
 * Records where the reader is in a document.
 *
 * An unknown id is ignored rather than inserted: a position without the facts
 * that let the document be reopened would be an entry the recent list could
 * never use. Position updates do not reorder the list, because scrolling is
 * not "using" a different document.
 */
export const rememberPosition = (
  state: ReaderState,
  id: string,
  position: ReadingPosition,
  pageCount: number | null = null,
): ReaderState => ({
  ...state,
  schemaVersion: CURRENT_SCHEMA_VERSION,
  documents: state.documents.map((document) =>
    document.id === id
      ? { ...document, position, pageCount: pageCount ?? document.pageCount }
      : document,
  ),
});

/** Drops a document, used when its file turns out to be gone or unreadable. */
export const forgetDocument = (state: ReaderState, id: string): ReaderState => ({
  ...state,
  schemaVersion: CURRENT_SCHEMA_VERSION,
  documents: state.documents.filter((document) => document.id !== id),
});

/**
 * Records the four settings.
 *
 * Nothing else in the document is touched: a preference change must not
 * reorder the recent list, rewrite a reading position or drop a record.
 */
export const rememberPreferences = (state: ReaderState, preferences: Preferences): ReaderState => ({
  ...state,
  preferences,
});

/**
 * The zoom the reader was last reading at, or `null` if nothing has been
 * read yet.
 *
 * This is what answers `defaultZoomMode: 'last-used'`. It is derived from
 * the most recent document's stored position rather than stored again, so
 * there is exactly one place a zoom lives.
 *
 * `excludingId` leaves one document out of the search, and exists because
 * of a defect the 6.8 closure audit found: a document is recorded by
 * `rememberOpen` *before* anything asks what zoom to open it at, so the
 * most recent document is the one being opened, and its position is the
 * freshly initialised `START_OF_DOCUMENT`. Answering with that turns
 * `last-used` into `fit-width` every time. Excluding the document in
 * question by identity makes the question the preference actually asks —
 * "what was I reading at before this one?" — answerable whether or not it
 * has already been recorded.
 */
export const lastUsedZoom = (
  state: ReaderState,
  excludingId: string | null = null,
): ZoomState | null =>
  state.documents.find((document) => document.id !== excludingId)?.position.zoom ?? null;
