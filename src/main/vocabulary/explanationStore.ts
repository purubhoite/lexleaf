import { randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { inTransaction } from './transaction';

/**
 * The only place in the application that writes SQL for explanations.
 *
 * It sits beside the vocabulary repository, on the same connection and the
 * same file, for one reason: remove → undo has to put a word and its
 * explanations back as a single transaction, and two connections cannot do
 * that. Nothing above this module knows that explanations live in SQLite —
 * the explanation service sees these methods and the row type, exactly as
 * the vocabulary service sees `VocabularyRepository` (ADR-022, ADR-028).
 *
 * Three rules are enforced here rather than promised:
 *
 * - **Rows are immutable.** There is no update method. A new context,
 *   prompt version, provider or model is a new row; re-asking an identical
 *   question is a no-op, resolved by the `UNIQUE` constraint rather than by
 *   reading first and deciding in TypeScript.
 * - **A hit means all seven dimensions matched.** `findExact` takes the
 *   whole identity tuple. There is deliberately no "newest row for this
 *   word on this page" query, because that would serve one passage's answer
 *   for another. The separate `findPrevious` exists only so the popup can
 *   *disclose* an earlier explanation, clearly labelled, never as the
 *   answer to the current question.
 * - **Rows are parsed, not trusted**, like every other row this project
 *   reads back: one that does not validate is skipped rather than shown.
 */

export interface StoredExplanation {
  readonly id: string;
  readonly itemId: string;
  readonly documentId: string;
  readonly page: number;
  readonly contextHash: string;
  readonly promptVersion: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly explanation: string;
  readonly senseIndex: number | null;
  readonly truncated: boolean;
  /** Which dictionary artifact produced the senses. Provenance, not identity. */
  readonly sourceId: number | null;
  /** ISO 8601. */
  readonly createdAt: string;
}

/** The complete identity tuple (ADR-028). Anything less is not a hit. */
export interface ExplanationIdentityQuery {
  readonly itemId: string;
  readonly documentId: string;
  readonly page: number;
  readonly contextHash: string;
  readonly promptVersion: string;
  readonly providerId: string;
  readonly modelId: string;
}

export interface NewExplanation extends ExplanationIdentityQuery {
  readonly explanation: string;
  readonly senseIndex: number | null;
  readonly truncated: boolean;
}

export interface ExplanationStore {
  /** Writes one row, or does nothing if that exact question is answered. */
  insert(entry: NewExplanation): StoredExplanation | null;
  /** The answer, only when every identity dimension matches. */
  findExact(query: ExplanationIdentityQuery): StoredExplanation | null;
  /** The newest row for an occurrence, for disclosure only. Never a hit. */
  findPrevious(query: {
    readonly itemId: string;
    readonly documentId: string;
    readonly page: number;
  }): StoredExplanation | null;
  /** Everything stored for one word, for the undo slot. */
  listForItem(itemId: string): readonly StoredExplanation[];
  /** Puts captured rows back verbatim: same ids, same timestamps. */
  restoreMany(rows: readonly StoredExplanation[]): void;
  /** Runs `work` in a transaction, nesting safely inside an outer one. */
  transaction<T>(work: () => T): T;
}

export interface ExplanationStoreOptions {
  readonly database: DatabaseSync;
  /** ISO 8601 clock, injected for tests. */
  readonly now?: () => string;
  readonly newId?: () => string;
}

const COLUMNS = `
  id, item_id, document_id, page, context_hash, prompt_version, provider_id, model_id,
  explanation, sense_index, truncated, source_id, created_at
`;

const IDENTITY_WHERE = `
  item_id = ? AND document_id = ? AND page = ? AND context_hash = ?
  AND prompt_version = ? AND provider_id = ? AND model_id = ?
`;

const identityValues = (query: ExplanationIdentityQuery): readonly (string | number)[] => [
  query.itemId,
  query.documentId,
  query.page,
  query.contextHash,
  query.promptVersion,
  query.providerId,
  query.modelId,
];

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const integer = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** A row that does not validate is not an explanation; it is skipped. */
const parseRow = (row: Record<string, unknown>): StoredExplanation | null => {
  const id = text(row['id']);
  const itemId = text(row['item_id']);
  const documentId = text(row['document_id']);
  const page = integer(row['page']);
  const contextHash = text(row['context_hash']);
  const promptVersion = text(row['prompt_version']);
  const providerId = text(row['provider_id']);
  const modelId = text(row['model_id']);
  const explanation = text(row['explanation']);
  const createdAt = text(row['created_at']);

  if (
    id === null ||
    itemId === null ||
    documentId === null ||
    page === null ||
    contextHash === null ||
    promptVersion === null ||
    providerId === null ||
    modelId === null ||
    explanation === null ||
    createdAt === null
  ) {
    return null;
  }

  return {
    id,
    itemId,
    documentId,
    page,
    contextHash,
    promptVersion,
    providerId,
    modelId,
    explanation,
    senseIndex: integer(row['sense_index']),
    truncated: integer(row['truncated']) === 1,
    sourceId: integer(row['source_id']),
    createdAt,
  };
};

export const createExplanationStore = ({
  database,
  now = (): string => new Date().toISOString(),
  newId = (): string => randomUUID(),
}: ExplanationStoreOptions): ExplanationStore => {
  const statements = new Map<string, StatementSync>();

  const statement = (sql: string): StatementSync => {
    const cached = statements.get(sql);

    if (cached !== undefined) {
      return cached;
    }

    const prepared = database.prepare(sql);

    statements.set(sql, prepared);

    return prepared;
  };

  const rows = (sql: string, values: readonly (string | number)[]): StoredExplanation[] => {
    const found = statement(sql).all(...values) as Record<string, unknown>[];
    const parsed: StoredExplanation[] = [];

    for (const row of found) {
      const explanation = parseRow(row);

      if (explanation !== null) {
        parsed.push(explanation);
      }
    }

    return parsed;
  };

  const findExact = (query: ExplanationIdentityQuery): StoredExplanation | null =>
    // Several rows can only exist if the same question was answered before
    // the UNIQUE constraint saw it; the newest is the one the reader last
    // generated.
    rows(
      `SELECT ${COLUMNS} FROM vocabulary_explanations
       WHERE ${IDENTITY_WHERE}
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
      identityValues(query),
    )[0] ?? null;

  /**
   * The dictionary source behind the saved word, if there is one.
   *
   * Read from the item rather than passed in, so provenance cannot be
   * supplied by a caller — and so an explanation for a word that has no
   * recorded source simply has none.
   */
  const sourceIdFor = (itemId: string): number | null => {
    const row = statement('SELECT source_id FROM vocabulary_items WHERE id = ?').get(itemId) as
      { source_id?: unknown } | undefined;

    return row === undefined ? null : integer(row['source_id']);
  };

  const insert = (entry: NewExplanation): StoredExplanation | null => {
    statement(
      `INSERT INTO vocabulary_explanations
         (id, item_id, document_id, page, context_hash, prompt_version, provider_id, model_id,
          explanation, sense_index, truncated, source_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (item_id, document_id, page, context_hash, prompt_version, provider_id, model_id)
       DO NOTHING`,
    ).run(
      newId(),
      entry.itemId,
      entry.documentId,
      entry.page,
      entry.contextHash,
      entry.promptVersion,
      entry.providerId,
      entry.modelId,
      entry.explanation,
      entry.senseIndex,
      entry.truncated ? 1 : 0,
      sourceIdFor(entry.itemId),
      now(),
    );

    return findExact(entry);
  };

  const findPrevious = ({
    itemId,
    documentId,
    page,
  }: {
    readonly itemId: string;
    readonly documentId: string;
    readonly page: number;
  }): StoredExplanation | null =>
    rows(
      `SELECT ${COLUMNS} FROM vocabulary_explanations
       WHERE item_id = ? AND document_id = ? AND page = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
      [itemId, documentId, page],
    )[0] ?? null;

  const listForItem = (itemId: string): readonly StoredExplanation[] =>
    rows(
      `SELECT ${COLUMNS} FROM vocabulary_explanations
       WHERE item_id = ?
       ORDER BY created_at ASC, rowid ASC`,
      [itemId],
    );

  const restoreMany = (captured: readonly StoredExplanation[]): void => {
    for (const row of captured) {
      statement(
        `INSERT INTO vocabulary_explanations
           (id, item_id, document_id, page, context_hash, prompt_version, provider_id, model_id,
            explanation, sense_index, truncated, source_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      ).run(
        row.id,
        row.itemId,
        row.documentId,
        row.page,
        row.contextHash,
        row.promptVersion,
        row.providerId,
        row.modelId,
        row.explanation,
        row.senseIndex,
        row.truncated ? 1 : 0,
        row.sourceId,
        // The original timestamp: a restored explanation is the same
        // explanation, not a new one.
        row.createdAt,
      );
    }
  };

  return {
    insert,
    findExact,
    findPrevious,
    listForItem,
    restoreMany,
    transaction: <T>(work: () => T): T => inTransaction(database, work),
  };
};
