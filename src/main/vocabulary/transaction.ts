import type { DatabaseSync } from 'node:sqlite';

/**
 * One transaction helper, nestable.
 *
 * Milestone 4 wrote `BEGIN IMMEDIATE` … `COMMIT` directly in the two
 * repository methods that needed it, which was right while only one layer
 * owned a transaction. Milestone 5 breaks that assumption: undo has to put
 * a word **and** its explanations back as a single unit, and the word half
 * of that work is `VocabularyRepository.restore`, which already opens its
 * own transaction.
 *
 * SQLite answers this with savepoints. When a transaction is already in
 * progress this emits `SAVEPOINT` / `RELEASE` / `ROLLBACK TO`, so the inner
 * unit of work is atomic *within* the outer one and the outer one still
 * decides whether anything is committed. When there is no transaction it
 * emits `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`, exactly as before, so
 * the behaviour of every M4 path is unchanged.
 *
 * `DatabaseSync.isTransaction` is what makes the distinction; it was
 * verified against the Node build this project runs on before this helper
 * was written.
 */

let depth = 0;

export const inTransaction = <T>(database: DatabaseSync, run: () => T): T => {
  const nested = database.isTransaction;

  if (!nested) {
    database.exec('BEGIN IMMEDIATE');

    try {
      const value = run();

      database.exec('COMMIT');

      return value;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // The transaction was already resolved; the original error stands.
      }

      throw error;
    }
  }

  depth += 1;
  // Savepoint names are generated here and never come from a caller, so
  // nothing outside this module can influence the statement text.
  const name = `vocabulary_sp_${String(depth)}`;

  database.exec(`SAVEPOINT ${name}`);

  try {
    const value = run();

    database.exec(`RELEASE ${name}`);

    return value;
  } catch (error) {
    try {
      database.exec(`ROLLBACK TO ${name}`);
      database.exec(`RELEASE ${name}`);
    } catch {
      // The outer transaction will roll the whole unit back.
    }

    throw error;
  } finally {
    depth -= 1;
  }
};
