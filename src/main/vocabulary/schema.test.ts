import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  DestructiveMigrationRequiresBackupError,
  MigrationFailedError,
  SchemaTooNewError,
  applyMigrationBody,
  migrate,
  migrateInOwnedTransaction,
  readSchemaVersion,
  type MigrationStep,
} from './schema';

/** The schema module is the only source of DDL, so it is tested directly. */

const open = (): DatabaseSync => new DatabaseSync(':memory:');

let databases: DatabaseSync[] = [];

const fresh = (): DatabaseSync => {
  const database = open();
  databases.push(database);

  return database;
};

afterEach(() => {
  for (const database of databases) {
    try {
      database.close();
    } catch {
      // Already closed by the test.
    }
  }

  databases = [];
});

const tableNames = (database: DatabaseSync): string[] =>
  (
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  ).map((row) => row.name);

const indexNames = (database: DatabaseSync): string[] =>
  (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .all() as { name: string }[]
  ).map((row) => row.name);

describe('migrating an empty database', () => {
  it('creates the five tables and records the version', () => {
    const database = fresh();
    const outcome = migrate(database);

    expect(outcome).toEqual({ from: 0, to: CURRENT_SCHEMA_VERSION, rewroteData: false });
    expect(tableNames(database).sort()).toEqual([
      'dictionary_sources',
      'documents',
      'vocabulary_explanations',
      'vocabulary_items',
      'vocabulary_occurrences',
    ]);
    expect(readSchemaVersion(database)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('creates exactly the six declared indexes and no index on item_id alone', () => {
    const database = fresh();
    migrate(database);

    expect(indexNames(database).sort()).toEqual([
      'idx_explanations_item_doc_page',
      'idx_items_created',
      'idx_items_display',
      'idx_items_headword',
      'idx_occ_document_item',
      'idx_occ_document_page',
    ]);
    expect(indexNames(database)).not.toContain('idx_occ_item');
  });

  it('is idempotent: migrating an up-to-date database does nothing', () => {
    const database = fresh();
    migrate(database);

    expect(migrate(database)).toEqual({
      from: CURRENT_SCHEMA_VERSION,
      to: CURRENT_SCHEMA_VERSION,
      rewroteData: false,
    });
  });
});

/**
 * Version 2 arrives on databases that already hold a reader's words, so
 * what matters is that it adds and changes nothing else.
 */
describe('migrating a version 1 database to version 2', () => {
  /** Builds a real v1 database using the v1 step, never pasted DDL. */
  const atVersionOne = (): DatabaseSync => {
    const database = fresh();
    const first = MIGRATIONS[0];

    if (first === undefined || first.version !== 1) {
      throw new Error('the version 1 step is missing');
    }

    first.apply(database);
    database.exec('PRAGMA user_version = 1');

    return database;
  };

  it('adds the explanation table and its index, and nothing else', () => {
    const database = atVersionOne();

    expect(tableNames(database)).not.toContain('vocabulary_explanations');

    const outcome = migrate(database);

    expect(outcome).toEqual({ from: 1, to: 2, rewroteData: false });
    expect(readSchemaVersion(database)).toBe(2);
    expect(tableNames(database)).toContain('vocabulary_explanations');
    expect(indexNames(database)).toContain('idx_explanations_item_doc_page');
  });

  it('is declared as not rewriting data, so no backup is taken', () => {
    const database = atVersionOne();
    const backups: number[] = [];

    migrate(database, (version) => backups.push(version));

    expect(MIGRATIONS.map((step) => step.rewritesData)).toEqual([false, false]);
    expect(backups).toEqual([]);
  });

  it('keeps the words that were already saved', () => {
    const database = atVersionOne();

    database.exec(
      "INSERT INTO documents (id, name, first_seen_at, last_seen_at) VALUES ('d', 'Essays.pdf', 'now', 'now')",
    );
    database.exec(
      `INSERT INTO vocabulary_items
         (id, normalized_word, display_word, raw_word, lookup_status, created_at, updated_at)
       VALUES ('i', 'charge', 'charge', 'charge', 'found', 'then', 'then')`,
    );

    migrate(database);

    expect(
      database.prepare('SELECT count(*) AS n FROM vocabulary_items').get() as { n: number },
    ).toEqual({ n: 1 });
  });

  it('refuses an explanation longer than the stored limit', () => {
    const database = fresh();

    migrate(database);
    database.exec(
      "INSERT INTO documents (id, name, first_seen_at, last_seen_at) VALUES ('d', 'n', 'now', 'now')",
    );
    database.exec(
      `INSERT INTO vocabulary_items
         (id, normalized_word, display_word, raw_word, lookup_status, created_at, updated_at)
       VALUES ('i', 'charge', 'charge', 'charge', 'found', 'now', 'now')`,
    );

    const insert = (length: number): void => {
      database
        .prepare(
          `INSERT INTO vocabulary_explanations
             (id, item_id, document_id, page, context_hash, prompt_version, provider_id,
              model_id, explanation, sense_index, truncated, source_id, created_at)
           VALUES (?, 'i', 'd', 1, 'hash', 'v', 'p', 'm', ?, NULL, 0, NULL, 'now')`,
        )
        .run(`e${String(length)}`, 'x'.repeat(length));
    };

    expect(() => insert(2001)).toThrow();
    expect(() => insert(2000)).not.toThrow();
  });
});

describe('refusing a database from the future', () => {
  it('leaves it untouched and says why', () => {
    const database = fresh();
    migrate(database);
    database.exec('PRAGMA user_version = 99');
    database.exec(
      "INSERT INTO documents (id, name, first_seen_at, last_seen_at) VALUES ('d', 'n', 'now', 'now')",
    );

    expect(() => migrate(database)).toThrow(SchemaTooNewError);
    expect(readSchemaVersion(database)).toBe(99);
    expect(database.prepare('SELECT count(*) AS n FROM documents').get() as { n: number }).toEqual({
      n: 1,
    });
  });
});

describe('a migration step that fails', () => {
  const failing: MigrationStep = {
    version: CURRENT_SCHEMA_VERSION + 1,
    rewritesData: true,
    apply: (database): void => {
      database.exec('CREATE TABLE half_built (id INTEGER PRIMARY KEY)');
      throw new Error('disk full');
    },
  };

  const migrateWith = (database: DatabaseSync, steps: readonly MigrationStep[]): void => {
    // The production loop, exercised with an extra step appended: a test
    // must not paste its own DDL, but it may add a step that misbehaves.
    const from = readSchemaVersion(database);

    for (const step of steps) {
      if (step.version <= from) {
        continue;
      }

      database.exec('BEGIN IMMEDIATE');

      try {
        step.apply(database);
        database.exec(`PRAGMA user_version = ${String(step.version)}`);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw new MigrationFailedError(step.version, error);
      }
    }
  };

  it('rolls back everything it did and leaves the version alone', () => {
    const database = fresh();
    migrate(database);

    expect(() => {
      migrateWith(database, [failing]);
    }).toThrow(MigrationFailedError);

    expect(tableNames(database)).not.toContain('half_built');
    expect(readSchemaVersion(database)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('keeps the data that was already there', () => {
    const database = fresh();
    migrate(database);
    database.exec(
      "INSERT INTO documents (id, name, first_seen_at, last_seen_at) VALUES ('d', 'Essays.pdf', 'now', 'now')",
    );

    expect(() => {
      migrateWith(database, [failing]);
    }).toThrow(MigrationFailedError);

    expect(database.prepare('SELECT name FROM documents').get() as { name: string }).toEqual({
      name: 'Essays.pdf',
    });
  });
});

describe('migration transaction ownership', () => {
  const destructive: MigrationStep = {
    version: CURRENT_SCHEMA_VERSION + 1,
    rewritesData: true,
    apply: (database): void => {
      database.exec('ALTER TABLE documents ADD COLUMN migrated INTEGER NOT NULL DEFAULT 0');
    },
  };

  it('discovers pending migrations in version order', () => {
    const database = fresh();
    migrate(database);
    expect(pendingMigrationsForTest(database, [destructive]).map((step) => step.version)).toEqual([
      destructive.version,
    ]);
  });

  it('applies a body inside a caller-owned transaction without nesting', () => {
    const database = fresh();
    migrate(database);
    database.exec('BEGIN IMMEDIATE');
    const outcome = migrateInOwnedTransaction(database, [destructive]);

    expect(outcome).toEqual({
      from: CURRENT_SCHEMA_VERSION,
      to: destructive.version,
      rewroteData: true,
    });
    expect(readSchemaVersion(database)).toBe(destructive.version);
    expect(() => database.exec('BEGIN IMMEDIATE')).toThrow();
    database.exec('ROLLBACK');
    expect(readSchemaVersion(database)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('refuses a destructive pending migration on the synchronous path', () => {
    const database = fresh();
    migrate(database);
    const original = readSchemaVersion(database);
    expect(() => migrateWithTestSteps(database, [destructive])).toThrow(
      DestructiveMigrationRequiresBackupError,
    );
    expect(readSchemaVersion(database)).toBe(original);
  });

  it('rolls back schema, version and data when the caller rolls back', () => {
    const database = fresh();
    migrate(database);
    database.exec(
      "INSERT INTO documents (id, name, first_seen_at, last_seen_at) VALUES ('d','n','a','a')",
    );
    database.exec('BEGIN IMMEDIATE');
    const failing: MigrationStep = {
      version: CURRENT_SCHEMA_VERSION + 1,
      rewritesData: true,
      apply: (db) => {
        db.exec('ALTER TABLE documents ADD COLUMN temporary TEXT');
        throw new Error('fail');
      },
    };
    expect(() => applyMigrationBody(database, failing)).toThrow('fail');
    database.exec('ROLLBACK');
    expect(readSchemaVersion(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(tableNames(database)).not.toContain('temporary');
    expect((database.prepare('SELECT count(*) n FROM documents').get() as { n: number }).n).toBe(1);
  });
});

// Test-only discovery/wrapper helpers keep the production migration list untouched.
const pendingMigrationsForTest = (
  database: DatabaseSync,
  extra: readonly MigrationStep[],
): readonly MigrationStep[] => {
  const version = readSchemaVersion(database);
  return extra.filter((step) => step.version > version);
};

const migrateWithTestSteps = (database: DatabaseSync, steps: readonly MigrationStep[]): void => {
  for (const step of steps) {
    if (step.rewritesData) throw new DestructiveMigrationRequiresBackupError(step.version);
    database.exec('BEGIN IMMEDIATE');
    try {
      applyMigrationBody(database, step);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
};

describe('the constraints the data depends on', () => {
  const seed = (database: DatabaseSync): void => {
    database.exec(
      `INSERT INTO documents (id, name, first_seen_at, last_seen_at)
       VALUES ('doc-1', 'Essays.pdf', 'now', 'now');
       INSERT INTO vocabulary_items
         (id, normalized_word, display_word, raw_word, lookup_status, created_at, updated_at)
       VALUES ('item-1', 'mice', 'Mice', 'Mice', 'found', 'now', 'now');`,
    );
  };

  const insertOccurrence = (
    database: DatabaseSync,
    page: number,
    charStart: number | null,
    charEnd: number | null,
    context: string | null = null,
  ): void => {
    database
      .prepare(
        `INSERT INTO vocabulary_occurrences
           (item_id, document_id, page, char_start, char_end, context, created_at)
         VALUES ('item-1', 'doc-1', ?, ?, ?, ?, 'now')`,
      )
      .run(page, charStart, charEnd, context);
  };

  it('allows one occurrence per word per page, anchored or not', () => {
    const database = fresh();
    migrate(database);
    seed(database);

    insertOccurrence(database, 7, null, null);

    expect(() => {
      insertOccurrence(database, 7, null, null);
    }).toThrow(/UNIQUE/u);
    expect(() => {
      insertOccurrence(database, 7, 10, 14);
    }).toThrow(/UNIQUE/u);

    insertOccurrence(database, 8, null, null);

    expect(
      database.prepare('SELECT count(*) AS n FROM vocabulary_occurrences').get() as { n: number },
    ).toEqual({ n: 2 });
  });

  it('rejects page 0', () => {
    const database = fresh();
    migrate(database);
    seed(database);

    expect(() => {
      insertOccurrence(database, 0, null, null);
    }).toThrow(/CHECK/u);
  });

  it('rejects a half anchor and an anchor that ends before it starts', () => {
    const database = fresh();
    migrate(database);
    seed(database);

    expect(() => {
      insertOccurrence(database, 1, 10, null);
    }).toThrow(/CHECK/u);
    expect(() => {
      insertOccurrence(database, 2, null, 14);
    }).toThrow(/CHECK/u);
    expect(() => {
      insertOccurrence(database, 3, 14, 10);
    }).toThrow(/CHECK/u);
    expect(() => {
      insertOccurrence(database, 4, 10, 10);
    }).toThrow(/CHECK/u);
    expect(() => {
      insertOccurrence(database, 5, -1, 4);
    }).toThrow(/CHECK/u);
  });

  it('accepts a 240-character excerpt and rejects a 241-character one', () => {
    const database = fresh();
    migrate(database);
    seed(database);

    insertOccurrence(database, 1, null, null, 'x'.repeat(240));

    expect(() => {
      insertOccurrence(database, 2, null, null, 'x'.repeat(241));
    }).toThrow(/CHECK/u);
  });

  it('treats the normalised word as the identity of an item', () => {
    const database = fresh();
    migrate(database);
    seed(database);

    expect(() => {
      database.exec(
        `INSERT INTO vocabulary_items
           (id, normalized_word, display_word, raw_word, lookup_status, created_at, updated_at)
         VALUES ('item-2', 'mice', 'mice', 'mice', 'found', 'now', 'now')`,
      );
    }).toThrow(/UNIQUE/u);
  });

  it('deletes occurrences with the item they belong to', () => {
    const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    databases.push(database);
    migrate(database);
    seed(database);
    insertOccurrence(database, 1, null, null);
    insertOccurrence(database, 2, null, null);

    database.exec("DELETE FROM vocabulary_items WHERE id = 'item-1'");

    expect(
      database.prepare('SELECT count(*) AS n FROM vocabulary_occurrences').get() as { n: number },
    ).toEqual({ n: 0 });
    // The document survives: it is provenance, not a child of the word.
    expect(database.prepare('SELECT count(*) AS n FROM documents').get() as { n: number }).toEqual({
      n: 1,
    });
  });
});
