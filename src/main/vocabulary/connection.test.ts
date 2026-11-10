import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BUSY_TIMEOUT_MS,
  VocabularyOpenError,
  classifyDatabaseError,
  openVocabularyDatabase,
} from './connection';
import {
  CURRENT_SCHEMA_VERSION,
  MigrationFailedError,
  SchemaTooNewError,
  readSchemaVersion,
} from './schema';

/** Opening is where most of this subsystem's failures happen, so it is tested there. */

let directories: string[] = [];

const workspace = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'vocabulary-connection-'));
  directories.push(directory);

  return directory;
};

afterEach(() => {
  for (const directory of directories) {
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Only the read-only test changes permissions.
    }

    rmSync(directory, { recursive: true, force: true });
  }

  directories = [];
});

describe('classifying a failure', () => {
  it('maps the SQLite result codes the investigation measured', () => {
    expect(classifyDatabaseError({ errcode: 26 })).toBe('not-a-database');
    expect(classifyDatabaseError({ errcode: 14 })).toBe('not-writable');
    expect(classifyDatabaseError({ errcode: 8 })).toBe('not-writable');
    expect(classifyDatabaseError({ errcode: 5 })).toBe('locked');
    expect(classifyDatabaseError({ errcode: 11 })).toBe('corrupt');
  });

  it('maps a schema and migration failure to their own reasons', () => {
    expect(classifyDatabaseError(new SchemaTooNewError(99, 1))).toBe('schema-too-new');
    expect(classifyDatabaseError(new MigrationFailedError(2, new Error('disk full')))).toBe(
      'migration-failed',
    );
  });

  it('falls back to the message when there is no result code', () => {
    expect(classifyDatabaseError(new Error('database disk image is malformed'))).toBe('corrupt');
    expect(classifyDatabaseError(new Error('database is locked'))).toBe('locked');
    expect(classifyDatabaseError(new Error('attempt to write a readonly database'))).toBe(
      'not-writable',
    );
  });

  it('admits when it does not know', () => {
    expect(classifyDatabaseError(new Error('something else entirely'))).toBe('unknown');
    expect(classifyDatabaseError(null)).toBe('unknown');
  });
});

describe('opening a database', () => {
  it('creates it, migrates it and turns on the pragmas that matter', () => {
    const filePath = join(workspace(), 'vocabulary.db');
    const { database, migration } = openVocabularyDatabase({ filePath });

    expect(migration).toEqual({ from: 0, to: CURRENT_SCHEMA_VERSION, rewroteData: false });
    expect(readSchemaVersion(database)).toBe(CURRENT_SCHEMA_VERSION);
    expect(database.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(database.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(BUSY_TIMEOUT_MS).toBe(2_000);

    database.close();
  });

  it('reopens an existing database without migrating it again', () => {
    const filePath = join(workspace(), 'vocabulary.db');
    const first = openVocabularyDatabase({ filePath });
    first.database.close();

    const second = openVocabularyDatabase({ filePath });

    expect(second.migration.from).toBe(CURRENT_SCHEMA_VERSION);
    second.database.close();
  });

  it('reports a file that is not a database, and leaves it alone', () => {
    const filePath = join(workspace(), 'vocabulary.db');
    writeFileSync(filePath, 'this is a text file, not a database');

    try {
      openVocabularyDatabase({ filePath });
      expect.unreachable('opening a text file should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(VocabularyOpenError);
      expect((error as VocabularyOpenError).reason).toBe('not-a-database');
    }
  });

  it('reports a database written by a newer build without changing it', () => {
    const filePath = join(workspace(), 'vocabulary.db');
    const prepared = openVocabularyDatabase({ filePath });
    prepared.database.exec('PRAGMA user_version = 99');
    prepared.database.close();

    try {
      openVocabularyDatabase({ filePath });
      expect.unreachable('a newer schema should be refused');
    } catch (error) {
      // Every failure leaves this module as a VocabularyOpenError, so no
      // caller has to know which layer threw.
      expect(error).toBeInstanceOf(VocabularyOpenError);
      expect((error as VocabularyOpenError).reason).toBe('schema-too-new');
    }

    const inspection = new DatabaseSync(filePath);

    expect(readSchemaVersion(inspection)).toBe(99);
    inspection.close();
  });

  it('reports a directory it cannot write to', () => {
    const directory = workspace();
    chmodSync(directory, 0o500);

    try {
      openVocabularyDatabase({ filePath: join(directory, 'vocabulary.db') });
      expect.unreachable('opening in a read-only directory should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(VocabularyOpenError);
      expect((error as VocabularyOpenError).reason).toBe('not-writable');
    }
  });

  it('puts no filesystem path into the reason it reports', () => {
    const directory = workspace();
    const filePath = join(directory, 'vocabulary.db');
    writeFileSync(filePath, 'not a database');

    try {
      openVocabularyDatabase({ filePath });
      expect.unreachable('opening a text file should fail');
    } catch (error) {
      const failure = error as VocabularyOpenError;

      expect(failure.message).not.toContain(directory);
      expect(failure.message).not.toContain('vocabulary.db');
      expect(failure.reason).toBe('not-a-database');
    }
  });
});
