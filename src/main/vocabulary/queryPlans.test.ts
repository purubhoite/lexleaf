import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { migrate } from './schema';

/**
 * Guards on how SQLite answers the two questions asked most often.
 *
 * The popup asks "is this word already saved here?" on every lookup, and
 * the library asks "where was this word met?" for every card it draws.
 * Both are answered by an index today. A schema change that quietly turned
 * either of them into a scan would not fail any other test — it would just
 * make the application slower as a reader's vocabulary grows — so the plan
 * itself is asserted here.
 *
 * The queries below are the ones the repository issues, and the database
 * is built by the schema module rather than from pasted DDL, so these
 * tests follow the schema instead of drifting from it.
 */

let databases: DatabaseSync[] = [];

const migrated = (): DatabaseSync => {
  const database = new DatabaseSync(':memory:');

  databases.push(database);
  migrate(database);

  return database;
};

afterEach(() => {
  for (const database of databases) {
    try {
      database.close();
    } catch {
      // Already closed.
    }
  }

  databases = [];
});

const planFor = (database: DatabaseSync, sql: string, ...parameters: unknown[]): string =>
  (
    database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(parameters as never[])) as {
      detail?: unknown;
    }[]
  )
    .map((row) => String(row['detail']))
    .join(' | ');

describe('the plan for the questions asked on every lookup', () => {
  it('finds the places a word was met by index, never by scanning them all', () => {
    const database = migrated();

    const plan = planFor(
      database,
      `SELECT occ.id FROM vocabulary_occurrences occ WHERE occ.item_id = ?
       ORDER BY occ.created_at ASC, occ.id ASC`,
      'item-1',
    );

    expect(plan).toContain('SEARCH');
    expect(plan).toContain('item_id=?');
    expect(plan).not.toContain('SCAN vocabulary_occurrences');
    // Recorded so a change of plan is visible in the diff, not just in a
    // slower application.
    expect(plan).toMatchInlineSnapshot(
      `"SEARCH occ USING INDEX sqlite_autoindex_vocabulary_occurrences_1 (item_id=?) | USE TEMP B-TREE FOR ORDER BY"`,
    );
  });

  it('answers "is this word saved on this page?" from an index alone', () => {
    const database = migrated();

    const plan = planFor(
      database,
      `SELECT 1 FROM vocabulary_occurrences
       WHERE item_id = ? AND document_id = ? AND page = ?`,
      'item-1',
      'doc-1',
      3,
    );

    expect(plan).toContain('SEARCH');
    expect(plan).toContain('item_id=? AND document_id=? AND page=?');
    expect(plan).not.toContain('SCAN');
    expect(plan).toMatchInlineSnapshot(
      `"SEARCH vocabulary_occurrences USING COVERING INDEX sqlite_autoindex_vocabulary_occurrences_1 (item_id=? AND document_id=? AND page=?)"`,
    );
  });

  it('finds an item by its normalised word by index', () => {
    const database = migrated();

    const plan = planFor(
      database,
      'SELECT id FROM vocabulary_items WHERE normalized_word = ?',
      'equanimity',
    );

    expect(plan).toContain('SEARCH');
    expect(plan).not.toContain('SCAN vocabulary_items');
  });
});
