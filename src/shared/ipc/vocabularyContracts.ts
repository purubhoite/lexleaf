import type { DictionaryResult } from '@core/dictionary/types';
import type { Result } from '@core/result';
import { MAX_CONTEXT_CHARACTERS } from '@core/vocabulary/context';
import { parseOccurrenceRow, parseSavedWordRow, type StoredRow } from '@core/vocabulary/rows';
import { LIBRARY_PAGE_SIZE, MAX_SEARCH_RESULTS } from '@core/vocabulary/search';
import type {
  DocumentFilterOption,
  LibraryCursor,
  LibraryPage,
  LibrarySort,
  OccurrenceLocation,
  SavedOccurrence,
  SavedWord,
  SavedWordForm,
  SavedWordState,
  SearchResults,
  VocabularyFailure,
  VocabularyUnavailableReason,
} from '@core/vocabulary/types';

import { parseDictionaryResult } from './contracts';

/**
 * What the vocabulary channels carry, and how it is checked.
 *
 * The requests are parsed in the main process because a renderer is not
 * trusted; the replies are parsed in the preload bridge because a renderer
 * should not have to defend itself against its own main process either.
 * Both directions are closed shapes: a sort order is one of three names, a
 * limit is a bounded integer, a page is a positive integer, and there is
 * nowhere in any of them to put a filesystem path or a fragment of SQL.
 */

/** The longest word the save path will consider, matching the dictionary's. */
export const MAXIMUM_SAVED_WORD_LENGTH = 128;

/** Bounds a free-text search so a query cannot become a workload. */
export const MAXIMUM_SEARCH_QUERY_LENGTH = 128;

export interface StateForWordRequest {
  readonly normalized: string;
  readonly documentId: string;
  readonly page: number;
}

export interface SaveWordIpcRequest {
  readonly word: SavedWordForm;
  readonly documentId: string;
  /** Known to the renderer once the document is rendered; may be absent. */
  readonly pageCount: number | null;
  readonly occurrence: OccurrenceLocation;
  /** The answer the popup was showing when the reader pressed save. */
  readonly result: DictionaryResult;
}

export interface LibraryIpcQuery {
  readonly sort: LibrarySort;
  readonly documentId: string | null;
  readonly cursor: LibraryCursor | null;
  readonly limit: number;
}

export interface SearchIpcQuery {
  readonly query: string;
  readonly documentId: string | null;
  readonly limit: number;
}

/** What the library screen needs in one reply. */
export interface LibraryIpcPage extends LibraryPage {
  readonly documents: readonly DocumentFilterOption[];
}

export interface SearchIpcResults extends SearchResults {
  readonly documents: readonly DocumentFilterOption[];
}

export type VocabularyIpcResult<T> = Result<T, VocabularyFailure>;

const SORTS: readonly LibrarySort[] = ['newest', 'oldest', 'alphabetical'];

const UNAVAILABLE_REASONS: readonly VocabularyUnavailableReason[] = [
  'not-writable',
  'not-a-database',
  'corrupt',
  'locked',
  'schema-too-new',
  'migration-failed',
  'recovery-required',
  'unknown',
];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

const isPageNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

const optionalInteger = (value: unknown, minimum: number): number | null | undefined => {
  if (value === null) {
    return null;
  }

  return typeof value === 'number' && Number.isInteger(value) && value >= minimum
    ? value
    : undefined;
};

const optionalFraction = (value: unknown): number | null | undefined => {
  if (value === null) {
    return null;
  }

  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
};

const optionalText = (value: unknown, maximum: number): string | null | undefined => {
  if (value === null) {
    return null;
  }

  return typeof value === 'string' && value.length <= maximum ? value : undefined;
};

const boundedLimit = (value: unknown, fallback: number, maximum: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return fallback;
  }

  return Math.min(Math.floor(value), maximum);
};

export const parseStateForWordRequest = (value: unknown): StateForWordRequest | null => {
  if (!isObject(value)) {
    return null;
  }

  const normalized = value['normalized'];
  const documentId = value['documentId'];
  const page = value['page'];

  if (
    !isText(normalized, MAXIMUM_SAVED_WORD_LENGTH) ||
    !isText(documentId, 128) ||
    !isPageNumber(page)
  ) {
    return null;
  }

  return { normalized, documentId, page };
};

const parseWordForm = (value: unknown): SavedWordForm | null => {
  if (!isObject(value)) {
    return null;
  }

  const raw = value['raw'];
  const display = value['display'];
  const normalized = value['normalized'];
  const joined = value['joinedAcrossLines'];

  if (
    !isText(raw, MAXIMUM_SAVED_WORD_LENGTH) ||
    !isText(display, MAXIMUM_SAVED_WORD_LENGTH) ||
    !isText(normalized, MAXIMUM_SAVED_WORD_LENGTH) ||
    typeof joined !== 'boolean'
  ) {
    return null;
  }

  return { raw, display, normalized, joinedAcrossLines: joined };
};

/**
 * An occurrence as the renderer describes it.
 *
 * The anchor is a pair or it is absent, the excerpt obeys the same limit
 * the database enforces, and nothing here can grow without bound.
 */
const parseOccurrenceLocation = (value: unknown): OccurrenceLocation | null => {
  if (!isObject(value)) {
    return null;
  }

  const page = value['page'];

  if (!isPageNumber(page)) {
    return null;
  }

  const charStart = optionalInteger(value['charStart'], 0);
  const charEnd = optionalInteger(value['charEnd'], 0);
  const pageOffsetFraction = optionalFraction(value['pageOffsetFraction']);
  const context = optionalText(value['context'], MAX_CONTEXT_CHARACTERS);
  const contextWordStart = optionalInteger(value['contextWordStart'], 0);

  if (
    charStart === undefined ||
    charEnd === undefined ||
    pageOffsetFraction === undefined ||
    context === undefined ||
    contextWordStart === undefined
  ) {
    return null;
  }

  if ((charStart === null) !== (charEnd === null)) {
    return null;
  }

  if (charStart !== null && charEnd !== null && charEnd <= charStart) {
    return null;
  }

  return { page, charStart, charEnd, pageOffsetFraction, context, contextWordStart };
};

export const parseSaveWordRequest = (value: unknown): SaveWordIpcRequest | null => {
  if (!isObject(value)) {
    return null;
  }

  const word = parseWordForm(value['word']);
  const documentId = value['documentId'];
  const occurrence = parseOccurrenceLocation(value['occurrence']);
  const result = parseDictionaryResult(value['result']);
  const pageCount = optionalInteger(value['pageCount'], 1);

  if (
    word === null ||
    !isText(documentId, 128) ||
    occurrence === null ||
    result === null ||
    pageCount === undefined
  ) {
    return null;
  }

  return { word, documentId, pageCount, occurrence, result };
};

export const parseItemId = (value: unknown): string | null => {
  if (isObject(value)) {
    const itemId = value['itemId'];

    return isText(itemId, 128) ? itemId : null;
  }

  return isText(value, 128) ? value : null;
};

const parseCursor = (value: unknown): LibraryCursor | null | undefined => {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isObject(value)) {
    return undefined;
  }

  const sortKey = value['sortKey'];
  const id = value['id'];

  return typeof sortKey === 'string' && sortKey.length <= 64 && isText(id, 128)
    ? { sortKey, id }
    : undefined;
};

export const parseLibraryQuery = (value: unknown): LibraryIpcQuery | null => {
  if (!isObject(value)) {
    return null;
  }

  const sort = SORTS.find((candidate) => candidate === value['sort']);
  const documentId = value['documentId'];
  const cursor = parseCursor(value['cursor']);

  if (sort === undefined || cursor === undefined) {
    return null;
  }

  if (documentId !== null && !isText(documentId, 128)) {
    return null;
  }

  return {
    sort,
    documentId,
    cursor,
    limit: boundedLimit(value['limit'], LIBRARY_PAGE_SIZE, LIBRARY_PAGE_SIZE),
  };
};

export const parseSearchQuery = (value: unknown): SearchIpcQuery | null => {
  if (!isObject(value)) {
    return null;
  }

  const query = value['query'];
  const documentId = value['documentId'];

  if (typeof query !== 'string' || query.length > MAXIMUM_SEARCH_QUERY_LENGTH) {
    return null;
  }

  if (documentId !== null && !isText(documentId, 128)) {
    return null;
  }

  return {
    query,
    documentId,
    limit: boundedLimit(value['limit'], MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS),
  };
};

/* Replies, parsed on the way back into the renderer. */

const parseFailure = (value: unknown): VocabularyFailure | null => {
  if (!isObject(value)) {
    return null;
  }

  const kind = value['kind'];

  if (kind === 'write-failed' || kind === 'not-found' || kind === 'invalid-request') {
    return { kind };
  }

  if (kind !== 'unavailable') {
    return null;
  }

  const reason = UNAVAILABLE_REASONS.find((candidate) => candidate === value['reason']);

  return reason === undefined ? null : { kind: 'unavailable', reason };
};

const parseResult = <T>(
  value: unknown,
  parseValue: (candidate: unknown) => T | null,
): VocabularyIpcResult<T> | null => {
  if (!isObject(value)) {
    return null;
  }

  if (value['ok'] === true) {
    const parsed = parseValue(value['value']);

    return parsed === null ? null : { ok: true, value: parsed };
  }

  if (value['ok'] !== false) {
    return null;
  }

  const failure = parseFailure(value['error']);

  return failure === null ? null : { ok: false, error: failure };
};

const parseState = (value: unknown): SavedWordState | null => {
  if (!isObject(value)) {
    return null;
  }

  const state = value['state'];

  if (state === 'not-saved') {
    return { state };
  }

  if (state !== 'saved-here' && state !== 'saved-elsewhere') {
    return null;
  }

  const itemId = value['itemId'];
  const otherPlaces = value['otherPlaces'];

  if (!isText(itemId, 128) || typeof otherPlaces !== 'number' || !Number.isInteger(otherPlaces)) {
    return null;
  }

  return { state, itemId, otherPlaces };
};

const parseOccurrence = (value: unknown): SavedOccurrence | null => {
  if (!isObject(value)) {
    return null;
  }

  return parseOccurrenceRow({
    document_id: value['documentId'],
    document_name: value['documentName'],
    last_known_path: value['documentPath'],
    page: value['page'],
    char_start: value['charStart'],
    char_end: value['charEnd'],
    page_offset_fraction: value['pageOffsetFraction'],
    context: value['context'],
    context_word_start: value['contextWordStart'],
    created_at: value['savedAt'],
  });
};

/**
 * A saved word on its way back to the renderer.
 *
 * Reuses the row parsers: the shape crossing the boundary is the shape the
 * store produced, so there is one definition of a valid saved word rather
 * than two that can drift apart.
 */
const parseSavedWord = (value: unknown): SavedWord | null => {
  if (!isObject(value)) {
    return null;
  }

  const word = parseWordForm(value['word']);
  const rawOccurrences = value['occurrences'];

  if (word === null || !Array.isArray(rawOccurrences)) {
    return null;
  }

  const occurrences: SavedOccurrence[] = [];

  for (const candidate of rawOccurrences) {
    const occurrence = parseOccurrence(candidate);

    if (occurrence === null) {
      return null;
    }

    occurrences.push(occurrence);
  }

  const source = value['source'];
  const row: StoredRow = {
    id: value['id'],
    normalized_word: word.normalized,
    display_word: word.display,
    raw_word: word.raw,
    joined_across_lines: word.joinedAcrossLines ? 1 : 0,
    headword: value['headword'],
    resolved_by: value['resolvedBy'],
    lookup_status: value['lookupStatus'],
    short_definition: value['shortDefinition'],
    snapshot_json: value['snapshot'] === null ? null : JSON.stringify(value['snapshot']),
    created_at: value['savedAt'],
    occurrence_count: value['occurrenceCount'],
    ...(isObject(source)
      ? {
          provider: source['provider'],
          dataset_name: source['datasetName'],
          dataset_release: source['datasetRelease'],
          transform_version: source['transformVersion'],
          attribution_json: JSON.stringify(source['attribution']),
        }
      : { provider: null }),
  };

  const item = parseSavedWordRow(row, occurrences);

  if (item === null) {
    return null;
  }

  // A snapshot that did not survive the trip is a malformed reply, not a
  // word that was saved without one.
  if (value['snapshot'] !== null && item.snapshot === null) {
    return null;
  }

  return item;
};

const parseList = <T>(value: unknown, parseItem: (candidate: unknown) => T | null): T[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const items: T[] = [];

  for (const candidate of value) {
    const item = parseItem(candidate);

    if (item === null) {
      return null;
    }

    items.push(item);
  }

  return items;
};

const parseDocumentOption = (value: unknown): DocumentFilterOption | null => {
  if (!isObject(value)) {
    return null;
  }

  const documentId = value['documentId'];
  const name = value['name'];
  const available = value['available'];
  const count = value['count'];

  if (
    !isText(documentId, 128) ||
    typeof name !== 'string' ||
    typeof available !== 'boolean' ||
    typeof count !== 'number'
  ) {
    return null;
  }

  return { documentId, name, available, count };
};

const parseUnreadable = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;

export const parseStateResult = (value: unknown): VocabularyIpcResult<SavedWordState> | null =>
  parseResult(value, parseState);

export const parseSavedWordResult = (value: unknown): VocabularyIpcResult<SavedWord> | null =>
  parseResult(value, parseSavedWord);

export const parseVoidResult = (value: unknown): VocabularyIpcResult<null> | null =>
  parseResult(value, () => null);

export const parseLibraryPageResult = (
  value: unknown,
): VocabularyIpcResult<LibraryIpcPage> | null =>
  parseResult(value, (candidate) => {
    if (!isObject(candidate)) {
      return null;
    }

    const items = parseList(candidate['items'], parseSavedWord);
    const documents = parseList(candidate['documents'], parseDocumentOption);
    const cursor = parseCursor(candidate['nextCursor']);

    if (items === null || documents === null || cursor === undefined) {
      return null;
    }

    return {
      items,
      documents,
      nextCursor: cursor,
      unreadable: parseUnreadable(candidate['unreadable']),
    };
  });

export const parseSearchResults = (value: unknown): VocabularyIpcResult<SearchIpcResults> | null =>
  parseResult(value, (candidate) => {
    if (!isObject(candidate)) {
      return null;
    }

    const matches = parseList(candidate['matches'], parseSavedWord);
    const definitionMatches = parseList(candidate['definitionMatches'], parseSavedWord);
    const documents = parseList(candidate['documents'], parseDocumentOption);

    if (matches === null || definitionMatches === null || documents === null) {
      return null;
    }

    return {
      matches,
      definitionMatches,
      documents,
      truncated: candidate['truncated'] === true,
      unreadable: parseUnreadable(candidate['unreadable']),
    };
  });

export const parseOccurrencesResult = (
  value: unknown,
): VocabularyIpcResult<readonly SavedOccurrence[]> | null =>
  parseResult(value, (candidate) => parseList(candidate, parseOccurrence));

/** Safe renderer-facing metadata for an independently validated backup. */
export interface VocabularyRecoveryBackup {
  readonly backupId: string;
  readonly createdAt: string;
  readonly schemaVersion: number;
  readonly databaseSize: number;
}

export type VocabularyRecoveryListResult =
  | {
      readonly ok: true;
      readonly backups: readonly VocabularyRecoveryBackup[];
      readonly recoveryRequired?: boolean;
    }
  | { readonly ok: false; readonly error: 'recovery-required' | 'blocked' };

export type VocabularyRecoveryRestoreRequest = {
  readonly backupId: string;
  readonly confirmedBackupId: string;
};

export type VocabularyRecoveryRestoreResult =
  | { readonly ok: true; readonly backupId: string }
  | {
      readonly ok: false;
      readonly error:
        | 'invalid-request'
        | 'unknown-backup'
        | 'not-authorized'
        | 'busy'
        | 'recovery-required'
        | 'blocked';
    };

export const parseVocabularyRecoveryListResult = (
  value: unknown,
): VocabularyRecoveryListResult | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record['ok'] === false &&
    (record['error'] === 'recovery-required' || record['error'] === 'blocked')
  )
    return { ok: false, error: record['error'] };
  if (record['ok'] !== true || !Array.isArray(record['backups'])) return null;
  const backups: VocabularyRecoveryBackup[] = [];
  for (const item of record['backups']) {
    if (typeof item !== 'object' || item === null) return null;
    const entry = item as Record<string, unknown>;
    if (
      typeof entry['backupId'] !== 'string' ||
      !/^[A-Za-z0-9._-]+$/.test(entry['backupId']) ||
      typeof entry['createdAt'] !== 'string' ||
      typeof entry['schemaVersion'] !== 'number' ||
      typeof entry['databaseSize'] !== 'number'
    )
      return null;
    backups.push({
      backupId: entry['backupId'],
      createdAt: entry['createdAt'],
      schemaVersion: entry['schemaVersion'],
      databaseSize: entry['databaseSize'],
    });
  }
  return { ok: true, backups, recoveryRequired: record['recoveryRequired'] === true };
};

export const parseVocabularyRecoveryRestoreResult = (
  value: unknown,
): VocabularyRecoveryRestoreResult | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record['ok'] === true && typeof record['backupId'] === 'string')
    return { ok: true, backupId: record['backupId'] };
  const errors = [
    'invalid-request',
    'unknown-backup',
    'not-authorized',
    'busy',
    'recovery-required',
    'blocked',
  ] as const;
  return record['ok'] === false &&
    typeof record['error'] === 'string' &&
    errors.includes(record['error'] as (typeof errors)[number])
    ? { ok: false, error: record['error'] as (typeof errors)[number] }
    : null;
};

export const parseVocabularyRecoveryRestoreRequest = (
  value: unknown,
): VocabularyRecoveryRestoreRequest | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['backupId'] !== 'string' || typeof record['confirmedBackupId'] !== 'string')
    return null;
  if (
    !/^[A-Za-z0-9._-]+$/.test(record['backupId']) ||
    record['backupId'] !== record['confirmedBackupId']
  )
    return null;
  return { backupId: record['backupId'], confirmedBackupId: record['confirmedBackupId'] };
};
