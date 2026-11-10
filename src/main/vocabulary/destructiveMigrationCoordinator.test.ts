import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { migrateWithVerifiedBackups } from './destructiveMigrationCoordinator';
import { migrate, type MigrationStep } from './schema';
import { createVocabularyBackupCoordinator } from './vocabularyBackupCoordinator';

describe('migrateWithVerifiedBackups', () => {
  it('backs up before a destructive body and commits the version in the same transaction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'migration-coordinator-'));
    const database = new DatabaseSync(join(directory, 'db'));
    migrate(database);
    const backup = createVocabularyBackupCoordinator({
      userDataPath: directory,
      applicationVersion: 'test',
    });
    const step: MigrationStep = {
      version: 3,
      rewritesData: true,
      apply: (db) => db.exec('CREATE TABLE synthetic_change (id INTEGER)'),
    };
    try {
      const result = await migrateWithVerifiedBackups(database, { backup }, [step]);
      expect(result.backups).toHaveLength(1);
      expect(
        (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(3);
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE name='synthetic_change'").get(),
      ).toBeTruthy();
      expect(await backup.verify(result.backups[0]!.backupId)).not.toBeNull();
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('includes an external commit made before the initial data_version observation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'migration-coordinator-'));
    const sourcePath = join(directory, 'db');
    const database = new DatabaseSync(sourcePath);
    migrate(database);
    const writer = new DatabaseSync(sourcePath);
    writer.exec(
      "INSERT INTO documents (id,name,first_seen_at,last_seen_at) VALUES ('before','b','n','n')",
    );
    const backup = createVocabularyBackupCoordinator({
      userDataPath: directory,
      applicationVersion: 'test',
    });
    const step: MigrationStep = {
      version: 3,
      rewritesData: true,
      apply: (db) => db.exec('CREATE TABLE before_change (id INTEGER)'),
    };
    try {
      const result = await migrateWithVerifiedBackups(database, { backup }, [step]);
      expect(result.backups).toHaveLength(1);
      expect(database.prepare("SELECT id FROM documents WHERE id='before'").get()).toBeTruthy();
      const published = join(
        directory,
        'vocabulary-backups',
        result.backups[0]!.backupId,
        'vocabulary.db',
      );
      const snapshot = new DatabaseSync(published, { readOnly: true });
      expect(snapshot.prepare("SELECT id FROM documents WHERE id='before'").get()).toBeTruthy();
      snapshot.close();
    } finally {
      writer.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('blocks an external writer after reservation acquisition until migration releases it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'migration-coordinator-'));
    const sourcePath = join(directory, 'db');
    const database = new DatabaseSync(sourcePath);
    migrate(database);
    const writer = new DatabaseSync(sourcePath);
    const backup = createVocabularyBackupCoordinator({
      userDataPath: directory,
      applicationVersion: 'test',
    });
    let blocked = false;
    const step: MigrationStep = {
      version: 3,
      rewritesData: true,
      apply: (db) => db.exec('CREATE TABLE reservation_change (id INTEGER)'),
    };
    try {
      await migrateWithVerifiedBackups(
        database,
        {
          backup,
          onReservationAcquired: () => {
            try {
              writer.exec('BEGIN IMMEDIATE');
            } catch {
              blocked = true;
            }
          },
        },
        [step],
      );
      expect(blocked).toBe(true);
      writer.exec('BEGIN IMMEDIATE');
      writer.exec(
        "INSERT INTO documents (id,name,first_seen_at,last_seen_at) VALUES ('after','a','n','n')",
      );
      writer.exec('COMMIT');
      expect(database.prepare("SELECT id FROM documents WHERE id='after'").get()).toBeTruthy();
    } finally {
      try {
        writer.exec('ROLLBACK');
      } catch {}
      writer.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a backup made stale during backup and retries from a fresh snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'migration-coordinator-'));
    const sourcePath = join(directory, 'db');
    const database = new DatabaseSync(sourcePath);
    migrate(database);
    const writer = new DatabaseSync(sourcePath);
    const real = createVocabularyBackupCoordinator({
      userDataPath: directory,
      applicationVersion: 'test',
    });
    let backups = 0;
    let changed = false;
    const backup = {
      create: async (source: DatabaseSync) => {
        backups += 1;
        return real.create(source);
      },
      inspect: real.inspect,
      verify: real.verify,
      inventory: real.inventory,
      quarantine: real.quarantine,
    };
    const step: MigrationStep = {
      version: 3,
      rewritesData: true,
      apply: (db) => db.exec('CREATE TABLE stale_retry (id INTEGER)'),
    };
    try {
      const result = await migrateWithVerifiedBackups(
        database,
        {
          backup,
          onBackupValidated: () => {
            if (!changed) {
              changed = true;
              writer.exec(
                "INSERT INTO documents (id,name,first_seen_at,last_seen_at) VALUES ('external','e','n','n')",
              );
            }
          },
        },
        [step],
      );
      expect(backups).toBe(2);
      expect(result.backups).toHaveLength(1);
      expect(
        (database.prepare("SELECT id FROM documents WHERE id='external'").get() as { id: string })
          .id,
      ).toBe('external');
    } finally {
      writer.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not proceed while an external writer holds the reservation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'migration-coordinator-'));
    const sourcePath = join(directory, 'db');
    const database = new DatabaseSync(sourcePath);
    migrate(database);
    const writer = new DatabaseSync(sourcePath);
    writer.exec('BEGIN IMMEDIATE');
    const backup = createVocabularyBackupCoordinator({
      userDataPath: directory,
      applicationVersion: 'test',
    });
    const step: MigrationStep = {
      version: 3,
      rewritesData: true,
      apply: (db) => db.exec('CREATE TABLE blocked_change (id INTEGER)'),
    };
    try {
      await expect(
        migrateWithVerifiedBackups(database, { backup, maxRetries: 2 }, [step]),
      ).rejects.toThrow();
      expect(
        (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(2);
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE name='blocked_change'").get(),
      ).toBeUndefined();
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('exhausts retries without migration and preserves a prior verified backup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'migration-coordinator-'));
    const sourcePath = join(directory, 'db');
    const database = new DatabaseSync(sourcePath);
    migrate(database);
    const writer = new DatabaseSync(sourcePath);
    const backup = createVocabularyBackupCoordinator({
      userDataPath: directory,
      applicationVersion: 'test',
    });
    const prior = await backup.create(database);
    writer.exec('BEGIN IMMEDIATE');
    const step: MigrationStep = {
      version: 3,
      rewritesData: true,
      apply: (db) => db.exec('CREATE TABLE exhausted_change (id INTEGER)'),
    };
    try {
      await expect(
        migrateWithVerifiedBackups(database, { backup, maxRetries: 1 }, [step]),
      ).rejects.toThrow();
      expect(
        (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(2);
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE name='exhausted_change'").get(),
      ).toBeUndefined();
      expect(await backup.verify(prior.backupId)).not.toBeNull();
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('commits each pending destructive migration with its own predecessor backup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'migration-coordinator-'));
    const database = new DatabaseSync(join(directory, 'db'));
    migrate(database);
    const backup = createVocabularyBackupCoordinator({
      userDataPath: directory,
      applicationVersion: 'test',
      supportedSchemaVersion: 4,
    });
    const steps: MigrationStep[] = [
      {
        version: 3,
        rewritesData: true,
        apply: (db) => db.exec('CREATE TABLE first_change (id INTEGER)'),
      },
      {
        version: 4,
        rewritesData: true,
        apply: (db) => db.exec('CREATE TABLE second_change (id INTEGER)'),
      },
    ];
    try {
      const result = await migrateWithVerifiedBackups(database, { backup }, steps);
      expect(result.backups).toHaveLength(2);
      expect((await backup.inspect()).length).toBe(2);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed on an ENOSPC-style publication error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'migration-coordinator-'));
    const database = new DatabaseSync(join(directory, 'db'));
    migrate(database);
    const error = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    const backup = {
      create: async () => {
        throw error;
      },
      inspect: async () => [],
      verify: async () => null,
      inventory: async () => [],
      quarantine: async () => {
        throw new Error('unused');
      },
    };
    const step: MigrationStep = {
      version: 3,
      rewritesData: true,
      apply: (db) => db.exec('CREATE TABLE enospc_change (id INTEGER)'),
    };
    try {
      await expect(migrateWithVerifiedBackups(database, { backup }, [step])).rejects.toMatchObject({
        code: 'ENOSPC',
      });
      expect(
        (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(2);
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE name='enospc_change'").get(),
      ).toBeUndefined();
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('prevents migration when backup creation fails and preserves the source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'migration-coordinator-'));
    const database = new DatabaseSync(join(directory, 'db'));
    migrate(database);
    const step: MigrationStep = {
      version: 3,
      rewritesData: true,
      apply: (db) => db.exec('CREATE TABLE should_not_exist (id INTEGER)'),
    };
    const backup = {
      create: async () => {
        throw new Error('backup failed');
      },
      inspect: async () => [],
      verify: async () => null,
      inventory: async () => [],
      quarantine: async () => {
        throw new Error('unused');
      },
    };
    try {
      await expect(migrateWithVerifiedBackups(database, { backup }, [step])).rejects.toThrow(
        'backup failed',
      );
      expect(
        (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(2);
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE name='should_not_exist'").get(),
      ).toBeUndefined();
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
