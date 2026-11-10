import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { migrate } from './schema';
import { createVocabularyBackupCoordinator } from './vocabularyBackupCoordinator';
import { createVocabularyRestoreCoordinator } from './vocabularyRestoreCoordinator';

describe('vocabulary restore coordinator', () => {
  it('requires explicit confirmation and preserves the live database before restore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vocabulary-restore-'));
    const livePath = join(root, 'live.db');
    const live = new DatabaseSync(livePath);
    migrate(live);
    live.exec(
      "INSERT INTO documents (id,name,first_seen_at,last_seen_at) VALUES ('old','old','n','n')",
    );
    live.close();
    const source = new DatabaseSync(livePath);
    const backups = createVocabularyBackupCoordinator({
      userDataPath: root,
      applicationVersion: 'test',
    });
    const manifest = await backups.create(source);
    source.close();
    let closed = 0;
    const restore = createVocabularyRestoreCoordinator({
      userDataPath: root,
      liveDatabasePath: livePath,
      backups,
      closeRuntime: () => {
        closed += 1;
      },
    });
    await expect(restore.restore(manifest.backupId, 'wrong')).rejects.toMatchObject({
      code: 'not-authorized',
    });
    const result = await restore.restore(manifest.backupId, manifest.backupId);
    expect(result.state).toBe('succeeded');
    expect(closed).toBe(1);
    expect(result.preservedPath).not.toBeNull();
    const restored = new DatabaseSync(livePath, { readOnly: true });
    try {
      expect(restored.prepare("SELECT id FROM documents WHERE id='old'").get()).toBeTruthy();
    } finally {
      restored.close();
    }
    expect(await backups.verify(manifest.backupId)).not.toBeNull();
    await rm(root, { recursive: true, force: true });
  });

  it('fails closed on publication fault without touching the selected backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vocabulary-restore-'));
    const livePath = join(root, 'live.db');
    const live = new DatabaseSync(livePath);
    migrate(live);
    live.close();
    const source = new DatabaseSync(livePath);
    const backups = createVocabularyBackupCoordinator({
      userDataPath: root,
      applicationVersion: 'test',
    });
    const manifest = await backups.create(source);
    source.close();
    const restore = createVocabularyRestoreCoordinator({
      userDataPath: root,
      liveDatabasePath: livePath,
      backups,
      closeRuntime: () => {},
      fault: (point) => {
        if (point === 'before-publish')
          throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
      },
    });
    await expect(restore.restore(manifest.backupId, manifest.backupId)).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    expect(await backups.verify(manifest.backupId)).not.toBeNull();
    await rm(root, { recursive: true, force: true });
  });
});
