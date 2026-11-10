import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  open as openFile,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { readSchemaVersion, CURRENT_SCHEMA_VERSION } from './schema';
import {
  BACKUP_DIRECTORY,
  DATABASE_FILENAME,
  type VocabularyBackupCoordinator,
} from './vocabularyBackupCoordinator';

export type RestoreState =
  'idle' | 'preparing' | 'preserving' | 'publishing' | 'succeeded' | 'failed';
export type RestoreFailure =
  | 'not-authorized'
  | 'invalid-backup'
  | 'live-busy'
  | 'preservation-failed'
  | 'publication-failed'
  | 'validation-failed'
  | 'interrupted';

export interface RestoreResult {
  readonly backupId: string;
  readonly preservedPath: string | null;
  readonly state: 'succeeded';
}
export interface RestoreCoordinator {
  readonly state: () => RestoreState;
  readonly restore: (backupId: string, confirmedBackupId: string) => Promise<RestoreResult>;
}

export interface RestoreCoordinatorOptions {
  readonly userDataPath: string;
  readonly liveDatabasePath: string;
  readonly backups: VocabularyBackupCoordinator;
  readonly closeRuntime: () => void;
  readonly openRuntime?: () => Promise<void>;
  readonly fault?: (
    point: 'after-preserve' | 'before-publish' | 'after-publish',
  ) => void | Promise<void>;
}

const digest = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const syncFile = async (path: string): Promise<void> => {
  const handle = await openFile(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const safeId = (id: string): boolean => /^[A-Za-z0-9._-]+$/.test(id);

export const createVocabularyRestoreCoordinator = ({
  userDataPath,
  liveDatabasePath,
  backups,
  closeRuntime,
  openRuntime,
  fault,
}: RestoreCoordinatorOptions) => {
  const root = join(userDataPath, BACKUP_DIRECTORY);
  const restoreRoot = join(userDataPath, 'vocabulary-restore-operations');
  let state: RestoreState = 'idle';

  const inspect = () => state;

  const restore = async (backupId: string, confirmedBackupId: string): Promise<RestoreResult> => {
    if (confirmedBackupId !== backupId)
      throw Object.assign(new Error('restore confirmation did not identify the selected backup'), {
        code: 'not-authorized',
      });
    if (!safeId(backupId))
      throw Object.assign(new Error('invalid backup selection'), { code: 'invalid-backup' });
    if (state !== 'idle' && state !== 'failed')
      throw Object.assign(new Error('restore already in progress'), { code: 'live-busy' });
    state = 'preparing';
    const manifest = await backups.verify(backupId);
    if (manifest === null) {
      state = 'failed';
      throw Object.assign(new Error('selected backup is no longer valid'), {
        code: 'invalid-backup',
      });
    }
    const source = join(root, backupId, DATABASE_FILENAME);
    const operationId = `${Date.now()}-${randomUUID()}`;
    const operation = join(restoreRoot, operationId);
    const record = join(operation, 'restore.json');
    let preservedPath: string | null = null;
    try {
      await mkdir(operation, { recursive: true });
      await writeFile(
        record,
        JSON.stringify({
          version: 1,
          state: 'started',
          backupId,
          createdAt: new Date().toISOString(),
        }),
        { flag: 'wx' },
      );
      closeRuntime();
      state = 'preserving';
      const liveInfo = await stat(liveDatabasePath).catch(() => null);
      if (liveInfo !== null) {
        preservedPath = join(operation, 'previous-vocabulary.db');
        const originalHash = await digest(liveDatabasePath);
        await rename(liveDatabasePath, preservedPath);
        for (const suffix of ['-wal', '-shm'])
          await rename(`${liveDatabasePath}${suffix}`, `${preservedPath}${suffix}`).catch(
            (error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            },
          );
        if ((await digest(preservedPath)) !== originalHash)
          throw new Error('preservation verification failed');
      }
      await fault?.('after-preserve');
      const temporary = join(operation, 'new-vocabulary.db');
      await copyFile(source, temporary);
      const independent = new DatabaseSync(temporary, { readOnly: true });
      try {
        const quick = (
          independent.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined
        )?.quick_check;
        if (
          quick !== 'ok' ||
          readSchemaVersion(independent) !== manifest.schemaVersion ||
          manifest.schemaVersion > CURRENT_SCHEMA_VERSION ||
          (await stat(temporary).then((s) => s.size)) !== manifest.databaseSize ||
          (await digest(temporary)) !== manifest.sha256
        )
          throw new Error('restored database validation failed');
      } finally {
        independent.close();
      }
      await syncFile(temporary);
      await fault?.('before-publish');
      state = 'publishing';
      await rename(temporary, liveDatabasePath);
      await writeFile(
        record,
        JSON.stringify({
          version: 1,
          state: 'published',
          backupId,
          createdAt: new Date().toISOString(),
        }),
        { flag: 'w' },
      );
      await fault?.('after-publish');
      const reopened = new DatabaseSync(liveDatabasePath, { readOnly: true });
      try {
        const quick = (
          reopened.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined
        )?.quick_check;
        if (quick !== 'ok') throw new Error('post-publication validation failed');
      } finally {
        reopened.close();
      }
      state = 'succeeded';
      await openRuntime?.();
      return { backupId, preservedPath, state: 'succeeded' };
    } catch (error) {
      state = 'failed';
      throw error;
    }
  };

  return { state: inspect, restore };
};
