import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { migrate } from './schema';
import { createVocabularyBackupCoordinator } from './vocabularyBackupCoordinator';
import { inspectLiveVocabularyDatabase, inspectVocabularyRecovery } from './vocabularyRecovery';

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'vocabulary-recovery-'));
  const sourcePath = join(root, 'live.db');
  const source = new DatabaseSync(sourcePath);
  migrate(source);
  source.close();
  const coordinator = createVocabularyBackupCoordinator({
    userDataPath: root,
    applicationVersion: 'test',
  });
  const open = new DatabaseSync(sourcePath);
  return { root, sourcePath, source: open, coordinator };
};

describe('vocabulary recovery inspection and quarantine', () => {
  it('discovers valid backups and reports incomplete and malformed artifacts', async () => {
    const { root, source, coordinator } = await setup();
    try {
      const valid = await coordinator.create(source);
      const backupRoot = join(root, 'vocabulary-backups');
      await mkdir(join(backupRoot, '.tmp-incomplete'));
      await mkdir(join(backupRoot, 'bad-manifest'));
      await writeFile(join(backupRoot, 'bad-manifest', 'manifest.json'), '{}');
      const inventory = await coordinator.inventory();
      expect(inventory.find((item) => item.name === valid.backupId)?.status).toBe(
        'valid-published',
      );
      expect(inventory.find((item) => item.name === '.tmp-incomplete')?.status).toBe(
        'incomplete-temporary',
      );
      expect(inventory.find((item) => item.name === 'bad-manifest')?.status).toBe(
        'invalid-manifest',
      );
    } finally {
      source.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects hash mismatch, unsupported schema and symlink artifacts', async () => {
    const { root, source, coordinator } = await setup();
    try {
      const valid = await coordinator.create(source);
      const backupRoot = join(root, 'vocabulary-backups');
      await writeFile(join(backupRoot, valid.backupId, 'vocabulary.db'), 'tampered');
      await symlink(valid.backupId, join(backupRoot, 'linked-backup'));
      const inventory = await coordinator.inventory();
      expect(inventory.find((item) => item.name === valid.backupId)?.status).toBe('hash-mismatch');
      expect(inventory.find((item) => item.name === 'linked-backup')?.status).toBe('symlink');
    } finally {
      source.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('quarantines safely, preserves bytes, and is observable', async () => {
    const { root, source, coordinator } = await setup();
    try {
      const backupRoot = join(root, 'vocabulary-backups');
      await mkdir(join(backupRoot, '.tmp-fault'), { recursive: true });
      await writeFile(join(backupRoot, '.tmp-fault', 'bytes'), 'preserve-me');
      const result = await coordinator.quarantine('.tmp-fault', 'incomplete temporary artifact');
      expect(result.quarantineName).not.toBe('.tmp-fault');
      expect(
        await readFile(join(backupRoot, result.quarantineName, 'artifact', 'bytes'), 'utf8'),
      ).toBe('preserve-me');
      expect(
        JSON.parse(
          await readFile(join(backupRoot, result.quarantineName, 'quarantine.json'), 'utf8'),
        ).reason,
      ).toBe('incomplete temporary artifact');
      expect(
        (await coordinator.inventory()).find((item) => item.name === result.quarantineName)?.status,
      ).toBe('quarantined');
    } finally {
      source.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('makes conservative live-database decisions without restoring or replacing', async () => {
    const { root, sourcePath, source, coordinator } = await setup();
    try {
      await coordinator.create(source);
      expect((await inspectVocabularyRecovery(sourcePath, coordinator)).decision).toBe('normal');
      source.close();
      await rm(sourcePath);
      const missing = await inspectVocabularyRecovery(sourcePath, coordinator);
      expect(missing.live.status).toBe('missing');
      expect(missing.decision).toBe('recovery-required');
      expect(await coordinator.inspect()).toHaveLength(1);
      expect(inspectLiveVocabularyDatabase(sourcePath).status).toBe('missing');
    } finally {
      try {
        source.close();
      } catch {
        // The live handle was explicitly closed before Windows cleanup.
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports corruption with and without a valid backup while preserving the live file', async () => {
    const withBackup = await setup();
    try {
      await withBackup.coordinator.create(withBackup.source);
      withBackup.source.close();
      await writeFile(withBackup.sourcePath, 'corrupt-live-database');
      expect(
        (await inspectVocabularyRecovery(withBackup.sourcePath, withBackup.coordinator)).decision,
      ).toBe('recovery-required');
    } finally {
      try {
        withBackup.source.close();
      } catch {}
      await rm(withBackup.root, { recursive: true, force: true });
    }
    const withoutBackup = await setup();
    try {
      withoutBackup.source.close();
      await writeFile(withoutBackup.sourcePath, 'corrupt-live-database');
      expect(
        (await inspectVocabularyRecovery(withoutBackup.sourcePath, withoutBackup.coordinator))
          .decision,
      ).toBe('blocked');
    } finally {
      try {
        withoutBackup.source.close();
      } catch {}
      await rm(withoutBackup.root, { recursive: true, force: true });
    }
  });
});
