import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { inTransaction } from './transaction';

/**
 * The helper that lets two units of work be one transaction.
 *
 * The behaviour that matters: an outer unit still decides whether anything
 * is committed, an inner failure rolls back only the inner work when the
 * outer one catches it, and an uncaught failure leaves nothing behind.
 */

let open: DatabaseSync[] = [];

const fresh = (): DatabaseSync => {
  const database = new DatabaseSync(':memory:');

  open.push(database);
  database.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');

  return database;
};

afterEach(() => {
  for (const database of open) {
    try {
      database.close();
    } catch {
      // Already closed.
    }
  }

  open = [];
});

const values = (database: DatabaseSync): string[] =>
  (database.prepare('SELECT value FROM t ORDER BY id').all() as { value: string }[]).map(
    (row) => row.value,
  );

const insert = (database: DatabaseSync, value: string): void => {
  database.prepare('INSERT INTO t (value) VALUES (?)').run(value);
};

describe('a single transaction', () => {
  it('commits the work and returns its value', () => {
    const database = fresh();

    expect(
      inTransaction(database, () => {
        insert(database, 'one');

        return 'done';
      }),
    ).toBe('done');
    expect(values(database)).toEqual(['one']);
    expect(database.isTransaction).toBe(false);
  });

  it('rolls everything back when the work throws', () => {
    const database = fresh();

    expect(() =>
      inTransaction(database, () => {
        insert(database, 'one');
        throw new Error('no');
      }),
    ).toThrow('no');
    expect(values(database)).toEqual([]);
    expect(database.isTransaction).toBe(false);
  });
});

describe('a nested transaction', () => {
  it('keeps both halves in one commit', () => {
    const database = fresh();

    inTransaction(database, () => {
      insert(database, 'outer');
      inTransaction(database, () => {
        insert(database, 'inner');
      });
    });

    expect(values(database)).toEqual(['outer', 'inner']);
  });

  it('loses both halves when the outer unit fails', () => {
    const database = fresh();

    expect(() =>
      inTransaction(database, () => {
        insert(database, 'outer');
        inTransaction(database, () => {
          insert(database, 'inner');
        });
        throw new Error('later');
      }),
    ).toThrow('later');
    expect(values(database)).toEqual([]);
  });

  it('undoes only the inner unit when the outer one recovers', () => {
    const database = fresh();

    inTransaction(database, () => {
      insert(database, 'outer');

      try {
        inTransaction(database, () => {
          insert(database, 'inner');
          throw new Error('inner failed');
        });
      } catch {
        // The outer unit decides to continue without the inner work.
      }

      insert(database, 'after');
    });

    expect(values(database)).toEqual(['outer', 'after']);
  });

  it('supports more than one level', () => {
    const database = fresh();

    inTransaction(database, () => {
      insert(database, 'a');
      inTransaction(database, () => {
        insert(database, 'b');
        inTransaction(database, () => {
          insert(database, 'c');
        });
      });
    });

    expect(values(database)).toEqual(['a', 'b', 'c']);
    expect(database.isTransaction).toBe(false);
  });
});
