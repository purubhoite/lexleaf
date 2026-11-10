import { randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { parseOccurrenceRow, parseSavedWordRow, type StoredRow } from '@core/vocabulary/rows';
import {
  LIBRARY_PAGE_SIZE,
  MAX_SEARCH_RESULTS,
  clampLimit,
  cursorFor,
  prepareSearch,
} from '@core/vocabulary/search';
import type {
  DocumentFilterOption,
  LibraryPage,
  LibraryQuery,
  LibrarySort,
  SaveWordRequest,
  SavedOccurrence,
  SavedWord,
  SavedWordState,
  SearchQuery,
  SearchResults,
  VocabularyRepository,
  WordStateQuery,
} from '@core/vocabulary/types';

import { inTransaction } from './transaction';

/**
 * The vocabulary store, and the only place in the application that writes
 * SQL against it.
 *
 * Nothing above this file knows that saved words live in SQLite: the
 * service, the IPC handlers and the renderer see the domain types from
 * `@core/vocabulary`. That boundary is what makes the storage decision
 * reversible (ADR-022).
 *
 * Two habits run through every method here:
 *
 * - **The database enforces the rules.** Duplicate occurrences are
 *   prevented by `UNIQUE (item_id, document_id, page)` and resolved by an
 *   atomic upsert, never by reading first and deciding in TypeScript. Two
 *   saves racing on the same page produce one row because SQLite says so.
 * - **Rows are parsed, not trusted.** Every row goes through the core
 *   parsers; one that does not validate is counted and skipped so the
 *   library can say "3 entries could not be read" instead of pretending
 *   they were never saved.
 */

const ITEM_COLUMNS = `
  items.id                  AS id,
  items.normalized_word     AS normalized_word,
  items.display_word        AS display_word,
  items.raw_word            AS raw_word,
  items.joined_across_lines AS joined_across_lines,
  items.headword            AS headword,
  items.resolved_by         AS resolved_by,
  items.lookup_status       AS lookup_status,
  items.short_definition    AS short_definition,
  items.snapshot_json       AS snapshot_json,
  items.created_at          AS created_at,
  sources.provider          AS provider,
  sources.dataset_name      AS dataset_name,
  sources.dataset_release   AS dataset_release,
  sources.transform_version AS transform_version,
  sources.attribution_json  AS attribution_json,
  (SELECT count(*) FROM vocabulary_occurrences occ WHERE occ.item_id = items.id)
                            AS occurrence_count
`;

const ITEM_FROM = `
  FROM vocabulary_items items
  LEFT JOIN dictionary_sources sources ON sources.id = items.source_id
`;

const OCCURRENCE_SELECT = `
  SELECT occ.document_id          AS document_id,
         docs.name                AS document_name,
         docs.last_known_path     AS last_known_path,
         occ.page                 AS page,
         occ.char_start           AS char_start,
         occ.char_end             AS char_end,
         occ.page_offset_fraction AS page_offset_fraction,
         occ.context              AS context,
         occ.context_word_start   AS context_word_start,
         occ.created_at           AS created_at
  FROM vocabulary_occurrences occ
  JOIN documents docs ON docs.id = occ.document_id
`;

/**
 * Sort orders are a closed set mapped to fixed SQL.
 *
 * No ordering string ever reaches a query from outside this module; a
 * renderer picks one of three names and gets one of three statements.
 */
const LIBRARY_ORDER: Record<LibrarySort, { readonly key: string; readonly direction: string }> = {
  newest: { key: 'items.created_at', direction: 'DESC' },
  oldest: { key: 'items.created_at', direction: 'ASC' },
  alphabetical: { key: 'items.display_word', direction: 'ASC' },
};

export interface RepositoryOptions {
  readonly database: DatabaseSync;
  /** Injected so tests can fix timestamps. */
  readonly now?: () => string;
}

interface ParsedRows {
  readonly items: SavedWord[];
  readonly unreadable: number;
}

export const createSqliteVocabularyRepository = ({
  database,
  now = (): string => new Date().toISOString(),
}: RepositoryOptions): VocabularyRepository => {
  const cache = new Map<string, StatementSync>();

  const statement = (sql: string): StatementSync => {
    const existing = cache.get(sql);

    if (existing !== undefined) {
      return existing;
    }

    const prepared = database.prepare(sql);
    cache.set(sql, prepared);

    return prepared;
  };

  const occurrencesOf = (
    itemId: string,
  ): { occurrences: SavedOccurrence[]; unreadable: number } => {
    const rows = statement(
      `${OCCURRENCE_SELECT} WHERE occ.item_id = ? ORDER BY occ.created_at ASC, occ.id ASC`,
    ).all(itemId) as StoredRow[];

    const occurrences: SavedOccurrence[] = [];
    let unreadable = 0;

    for (const row of rows) {
      const occurrence = parseOccurrenceRow(row);

      if (occurrence === null) {
        unreadable += 1;
        continue;
      }

      occurrences.push(occurrence);
    }

    return { occurrences, unreadable };
  };

  const hydrate = (rows: readonly StoredRow[]): ParsedRows => {
    const items: SavedWord[] = [];
    let unreadable = 0;

    for (const row of rows) {
      const id = row['id'];

      if (typeof id !== 'string') {
        unreadable += 1;
        continue;
      }

      const found = occurrencesOf(id);
      const item = parseSavedWordRow(row, found.occurrences);

      if (item === null) {
        unreadable += 1;
        continue;
      }

      unreadable += found.unreadable;
      items.push(item);
    }

    return { items, unreadable };
  };

  /** Provenance is the vocabulary's own; it never borrows the recent list. */
  const rememberDocument = (
    id: string,
    name: string,
    path: string | null,
    pageCount: number | null,
    sizeBytes: number | null,
    timestamp: string,
  ): void => {
    statement(
      `INSERT INTO documents (id, name, last_known_path, page_count, size_bytes, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name            = excluded.name,
         last_known_path = excluded.last_known_path,
         page_count      = COALESCE(excluded.page_count, documents.page_count),
         size_bytes      = COALESCE(excluded.size_bytes, documents.size_bytes),
         last_seen_at    = excluded.last_seen_at`,
    ).run(id, name, path, pageCount, sizeBytes, timestamp, timestamp);
  };

  const rememberSource = (request: SaveWordRequest, timestamp: string): number | null => {
    const { source } = request;

    if (source === null) {
      return null;
    }

    statement(
      `INSERT INTO dictionary_sources
         (provider, dataset_name, dataset_release, transform_version, attribution_json, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, dataset_release, transform_version) DO NOTHING`,
    ).run(
      source.provider,
      source.datasetName,
      source.datasetRelease,
      source.transformVersion,
      JSON.stringify(source.attribution),
      timestamp,
    );

    const row = statement(
      `SELECT id FROM dictionary_sources
       WHERE provider = ? AND dataset_release = ? AND transform_version = ?`,
    ).get(source.provider, source.datasetRelease, source.transformVersion) as
      { id?: unknown } | undefined;

    return typeof row?.['id'] === 'number' ? row['id'] : null;
  };

  /**
   * One occurrence per word per page, decided by the database.
   *
   * `COALESCE(occ.column, excluded.column)` is the whole of the first-wins
   * rule: a later save fills in an anchor or an excerpt that was missing,
   * and never overwrites one that is already there. `created_at` is absent
   * from the SET clause, so the date a word was first met on a page cannot
   * drift (ADR-026).
   */
  const upsertOccurrence = (
    itemId: string,
    documentId: string,
    request: SaveWordRequest,
    timestamp: string,
  ): void => {
    const { occurrence } = request;

    statement(
      `INSERT INTO vocabulary_occurrences
         (item_id, document_id, page, char_start, char_end, page_offset_fraction,
          context, context_word_start, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (item_id, document_id, page) DO UPDATE SET
         char_start           = COALESCE(vocabulary_occurrences.char_start, excluded.char_start),
         char_end             = COALESCE(vocabulary_occurrences.char_end, excluded.char_end),
         page_offset_fraction = COALESCE(vocabulary_occurrences.page_offset_fraction,
                                         excluded.page_offset_fraction),
         context              = COALESCE(vocabulary_occurrences.context, excluded.context),
         context_word_start   = COALESCE(vocabulary_occurrences.context_word_start,
                                         excluded.context_word_start)`,
    ).run(
      itemId,
      documentId,
      occurrence.page,
      occurrence.charStart,
      occurrence.charEnd,
      occurrence.pageOffsetFraction,
      occurrence.context,
      occurrence.contextWordStart,
      timestamp,
    );
  };

  const itemByNormalized = (normalized: string): StoredRow | undefined =>
    statement(`SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE items.normalized_word = ?`).get(
      normalized,
    );

  const itemById = (id: string): StoredRow | undefined =>
    statement(`SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE items.id = ?`).get(id);

  const readItem = (row: StoredRow): SavedWord => {
    const id = String(row['id']);
    const item = parseSavedWordRow(row, occurrencesOf(id).occurrences);

    if (item === null) {
      throw new Error('a row written by this build did not read back');
    }

    return item;
  };

  const find = (itemId: string): SavedWord | null => {
    const row = itemById(itemId);

    return row === undefined ? null : parseSavedWordRow(row, occurrencesOf(itemId).occurrences);
  };

  const save = (request: SaveWordRequest): SavedWord => {
    const timestamp = now();
    const { word, document } = request;

    const itemId = inTransaction(database, () => {
      rememberDocument(
        document.id,
        document.name,
        document.path,
        document.pageCount,
        document.sizeBytes,
        timestamp,
      );

      const sourceId = rememberSource(request, timestamp);
      const existing = itemByNormalized(word.normalized);
      const saved = existing === undefined ? randomUUID() : String(existing['id']);

      if (existing === undefined) {
        statement(
          `INSERT INTO vocabulary_items
             (id, normalized_word, display_word, raw_word, joined_across_lines, headword,
              resolved_by, lookup_status, short_definition, snapshot_json, source_id,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          saved,
          word.normalized,
          word.display,
          word.raw,
          word.joinedAcrossLines ? 1 : 0,
          request.headword,
          request.resolvedBy,
          request.lookupStatus,
          request.shortDefinition,
          request.snapshot === null ? null : JSON.stringify(request.snapshot),
          sourceId,
          timestamp,
          timestamp,
        );
      } else {
        // Saving the same word somewhere else adds a place. It must not
        // rewrite the answer the reader kept, nor the date they kept it.
        statement('UPDATE vocabulary_items SET updated_at = ? WHERE id = ?').run(timestamp, saved);
      }

      upsertOccurrence(saved, document.id, request, timestamp);

      return saved;
    });

    const row = itemById(itemId);

    if (row === undefined) {
      throw new Error('the saved item could not be read back');
    }

    return readItem(row);
  };

  const stateForWord = ({ normalized, documentId, page }: WordStateQuery): SavedWordState => {
    const row = statement('SELECT id FROM vocabulary_items WHERE normalized_word = ?').get(
      normalized,
    ) as { id?: unknown } | undefined;

    if (typeof row?.['id'] !== 'string') {
      return { state: 'not-saved' };
    }

    const itemId = row['id'];
    const here = statement(
      `SELECT 1 FROM vocabulary_occurrences
       WHERE item_id = ? AND document_id = ? AND page = ?`,
    ).get(itemId, documentId, page);

    const counted = statement(
      'SELECT count(*) AS places FROM vocabulary_occurrences WHERE item_id = ?',
    ).get(itemId) as { places?: unknown } | undefined;
    const places = typeof counted?.['places'] === 'number' ? counted['places'] : 0;

    return here === undefined
      ? { state: 'saved-elsewhere', itemId, otherPlaces: places }
      : { state: 'saved-here', itemId, otherPlaces: Math.max(places - 1, 0) };
  };

  /** Removing an item removes its occurrences, by `ON DELETE CASCADE`. */
  const remove = (itemId: string): void => {
    statement('DELETE FROM vocabulary_items WHERE id = ?').run(itemId);
  };

  /**
   * Puts back exactly what `remove` took away, timestamps included.
   *
   * Undo is not a second save: a re-save would stamp today's date on a word
   * the reader kept last month, so the original rows are written back as
   * they were.
   */
  const restore = (item: SavedWord): void => {
    inTransaction(database, () => {
      let sourceId: number | null = null;

      if (item.source !== null) {
        statement(
          `INSERT INTO dictionary_sources
             (provider, dataset_name, dataset_release, transform_version, attribution_json, first_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (provider, dataset_release, transform_version) DO NOTHING`,
        ).run(
          item.source.provider,
          item.source.datasetName,
          item.source.datasetRelease,
          item.source.transformVersion,
          JSON.stringify(item.source.attribution),
          item.savedAt,
        );

        const row = statement(
          `SELECT id FROM dictionary_sources
           WHERE provider = ? AND dataset_release = ? AND transform_version = ?`,
        ).get(item.source.provider, item.source.datasetRelease, item.source.transformVersion) as
          { id?: unknown } | undefined;

        sourceId = typeof row?.['id'] === 'number' ? row['id'] : null;
      }

      statement(
        `INSERT INTO vocabulary_items
           (id, normalized_word, display_word, raw_word, joined_across_lines, headword,
            resolved_by, lookup_status, short_definition, snapshot_json, source_id,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      ).run(
        item.id,
        item.word.normalized,
        item.word.display,
        item.word.raw,
        item.word.joinedAcrossLines ? 1 : 0,
        item.headword,
        item.resolvedBy,
        item.lookupStatus,
        item.shortDefinition,
        item.snapshot === null ? null : JSON.stringify(item.snapshot),
        sourceId,
        item.savedAt,
        item.savedAt,
      );

      for (const occurrence of item.occurrences) {
        rememberDocument(
          occurrence.documentId,
          occurrence.documentName,
          occurrence.documentPath,
          null,
          null,
          occurrence.savedAt,
        );

        statement(
          `INSERT INTO vocabulary_occurrences
             (item_id, document_id, page, char_start, char_end, page_offset_fraction,
              context, context_word_start, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (item_id, document_id, page) DO NOTHING`,
        ).run(
          item.id,
          occurrence.documentId,
          occurrence.page,
          occurrence.charStart,
          occurrence.charEnd,
          occurrence.pageOffsetFraction,
          occurrence.context,
          occurrence.contextWordStart,
          occurrence.savedAt,
        );
      }
    });
  };

  /**
   * One page of the library, by keyset rather than by `OFFSET`.
   *
   * The cursor carries the sort key and the row id, so a word saved while
   * the reader is on page three cannot make them see a row twice or miss
   * one.
   */
  const list = ({ sort, documentId, cursor, limit }: LibraryQuery): LibraryPage => {
    const order = LIBRARY_ORDER[sort];
    const size = clampLimit(limit, LIBRARY_PAGE_SIZE);
    const comparison = order.direction === 'DESC' ? '<' : '>';
    const conditions: string[] = [];
    const parameters: (string | number)[] = [];

    if (documentId !== null) {
      conditions.push(
        `EXISTS (SELECT 1 FROM vocabulary_occurrences occ
                 WHERE occ.item_id = items.id AND occ.document_id = ?)`,
      );
      parameters.push(documentId);
    }

    if (cursor !== null) {
      conditions.push(
        `(${order.key} ${comparison} ? OR (${order.key} = ? AND items.id ${comparison} ?))`,
      );
      parameters.push(cursor.sortKey, cursor.sortKey, cursor.id);
    }

    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const rows = statement(
      `SELECT ${ITEM_COLUMNS} ${ITEM_FROM} ${where}
       ORDER BY ${order.key} ${order.direction}, items.id ${order.direction}
       LIMIT ?`,
    ).all(...parameters, size + 1) as StoredRow[];

    const hasMore = rows.length > size;
    const { items, unreadable } = hydrate(hasMore ? rows.slice(0, size) : rows);
    const last = items.at(-1);

    return {
      items,
      nextCursor: hasMore && last !== undefined ? cursorFor(last, sort) : null,
      unreadable,
    };
  };

  /**
   * Two tiers, never mixed and never scored.
   *
   * A prefix hit on the word is what the reader almost always means; a
   * definition hit is a fallback, searched only from three characters and
   * listed after every word hit.
   */
  const search = ({ query, documentId, limit }: SearchQuery): SearchResults => {
    const prepared = prepareSearch(query);
    const size = clampLimit(limit, MAX_SEARCH_RESULTS);

    if (prepared.kind === 'listing') {
      const page = list({ sort: 'newest', documentId, cursor: null, limit: size });

      return {
        matches: page.items,
        definitionMatches: [],
        truncated: page.nextCursor !== null,
        unreadable: page.unreadable,
      };
    }

    const { plan } = prepared;
    const documentFilter =
      documentId === null
        ? ''
        : `AND EXISTS (SELECT 1 FROM vocabulary_occurrences occ
                       WHERE occ.item_id = items.id AND occ.document_id = ?)`;
    const documentParameters = documentId === null ? [] : [documentId];

    const wordRows = statement(
      `SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
       WHERE (items.normalized_word LIKE ? ESCAPE '\\'
              OR items.display_word LIKE ? ESCAPE '\\'
              OR items.headword LIKE ? ESCAPE '\\')
       ${documentFilter}
       ORDER BY items.display_word ASC, items.id ASC
       LIMIT ?`,
    ).all(
      plan.prefixPattern,
      plan.prefixPattern,
      plan.prefixPattern,
      ...documentParameters,
      size + 1,
    ) as StoredRow[];

    const wordTruncated = wordRows.length > size;
    const words = hydrate(wordTruncated ? wordRows.slice(0, size) : wordRows);
    const remaining = size - words.items.length;

    if (plan.definitionPattern === null || remaining <= 0) {
      return {
        matches: words.items,
        definitionMatches: [],
        truncated: wordTruncated,
        unreadable: words.unreadable,
      };
    }

    const definitionRows = statement(
      `SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
       WHERE items.short_definition LIKE ? ESCAPE '\\'
         AND items.normalized_word NOT LIKE ? ESCAPE '\\'
         AND items.display_word NOT LIKE ? ESCAPE '\\'
         AND (items.headword IS NULL OR items.headword NOT LIKE ? ESCAPE '\\')
       ${documentFilter}
       ORDER BY items.display_word ASC, items.id ASC
       LIMIT ?`,
    ).all(
      plan.definitionPattern,
      plan.prefixPattern,
      plan.prefixPattern,
      plan.prefixPattern,
      ...documentParameters,
      remaining + 1,
    ) as StoredRow[];

    const definitionTruncated = definitionRows.length > remaining;
    const definitions = hydrate(
      definitionTruncated ? definitionRows.slice(0, remaining) : definitionRows,
    );

    return {
      matches: words.items,
      definitionMatches: definitions.items,
      truncated: wordTruncated || definitionTruncated,
      unreadable: words.unreadable + definitions.unreadable,
    };
  };

  const occurrences = (itemId: string): readonly SavedOccurrence[] =>
    occurrencesOf(itemId).occurrences;

  const documents = (): readonly DocumentFilterOption[] => {
    const rows = statement(
      `SELECT docs.id              AS id,
              docs.name            AS name,
              docs.last_known_path AS last_known_path,
              count(DISTINCT occ.item_id) AS count
       FROM documents docs
       JOIN vocabulary_occurrences occ ON occ.document_id = docs.id
       GROUP BY docs.id
       ORDER BY docs.name ASC`,
    ).all() as StoredRow[];

    const options: DocumentFilterOption[] = [];

    for (const row of rows) {
      const id = row['id'];
      const name = row['name'];
      const count = row['count'];

      if (typeof id !== 'string' || typeof name !== 'string' || typeof count !== 'number') {
        continue;
      }

      options.push({
        documentId: id,
        name,
        // Whether the file is still where it was is decided when it is
        // opened, not here: this store does not touch the filesystem.
        available: typeof row['last_known_path'] === 'string',
        count,
      });
    }

    return options;
  };

  return {
    stateForWord,
    save,
    find,
    remove,
    restore,
    list,
    search,
    occurrences,
    documents,
    close: (): void => {
      cache.clear();
      database.close();
    },
  };
};
