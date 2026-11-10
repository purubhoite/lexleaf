import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import {
  createVocabularyBackupCoordinator,
  parseVocabularyBackupManifest,
} from './vocabularyBackupCoordinator';
import { migrate } from './schema';

describe('VocabularyBackupCoordinator', () => {
  it('creates a self-contained validated backup from a WAL database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vocabulary-backup-'));
    const sourcePath = join(directory, 'source.db');
    const source = new DatabaseSync(sourcePath);
    try {
      source.exec('PRAGMA journal_mode = WAL');
      migrate(source);
      source.exec(
        "INSERT INTO documents (id,name,first_seen_at,last_seen_at) VALUES ('d','Document','now','now')",
      );
      const coordinator = createVocabularyBackupCoordinator({
        userDataPath: directory,
        applicationVersion: 'test',
      });
      const manifest = await coordinator.create(source);
      expect(manifest.validation).toEqual({
        quickCheck: 'ok',
        independentlyOpened: true,
        sidecarsRequired: false,
      });
      expect(await coordinator.verify(manifest.backupId)).not.toBeNull();
      expect((await coordinator.inspect()).length).toBe(1);
      const raw = JSON.parse(
        await readFile(
          join(directory, 'vocabulary-backups', manifest.backupId, 'manifest.json'),
          'utf8',
        ),
      );
      expect(parseVocabularyBackupManifest(raw).sha256).toBe(manifest.sha256);
    } finally {
      source.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not publish failed or malformed backups and retains verified history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vocabulary-backup-'));
    const source = new DatabaseSync(join(directory, 'source.db'));
    try {
      migrate(source);
      let fail = false;
      const backup = async (_source: DatabaseSync, destination: string): Promise<void> => {
        if (fail) throw new Error('injected backup failure');
        const copy = new DatabaseSync(destination);
        copy.exec('PRAGMA user_version=2');
        copy.close();
      };
      const coordinator = createVocabularyBackupCoordinator({
        userDataPath: directory,
        applicationVersion: 'test',
        backup,
        retention: 1,
      });
      const first = await coordinator.create(source);
      fail = true;
      await expect(coordinator.create(source)).rejects.toThrow('injected backup failure');
      expect(await coordinator.verify(first.backupId)).not.toBeNull();
    } finally {
      source.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
