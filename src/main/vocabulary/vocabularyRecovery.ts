import { lstatSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CURRENT_SCHEMA_VERSION, readSchemaVersion } from './schema';
import type {
  BackupArtifactInspection,
  VocabularyBackupCoordinator,
} from './vocabularyBackupCoordinator';

export type LiveVocabularyStatus =
  'healthy' | 'missing' | 'corrupt' | 'unsupported' | 'inaccessible';
export type VocabularyRecoveryDecision = 'normal' | 'recovery-required' | 'blocked';

export interface LiveVocabularyInspection {
  readonly status: LiveVocabularyStatus;
  readonly schemaVersion?: number;
  readonly reason?: string;
}

export interface VocabularyRecoveryInspection {
  readonly live: LiveVocabularyInspection;
  readonly artifacts: readonly BackupArtifactInspection[];
  readonly validBackupCount: number;
  readonly decision: VocabularyRecoveryDecision;
  readonly interruptedRestore: boolean;
}

export const inspectLiveVocabularyDatabase = (filePath: string): LiveVocabularyInspection => {
  try {
    const entry = lstatSync(filePath);
    if (entry.isSymbolicLink() || !entry.isFile())
      return { status: 'inaccessible', reason: 'live database is not a regular file' };
    const database = new DatabaseSync(filePath, { readOnly: true });
    try {
      const quick = (
        database.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined
      )?.quick_check;
      const version = readSchemaVersion(database);
      if (quick !== 'ok')
        return { status: 'corrupt', schemaVersion: version, reason: 'integrity check failed' };
      if (version > CURRENT_SCHEMA_VERSION)
        return {
          status: 'unsupported',
          schemaVersion: version,
          reason: 'schema is newer than this application',
        };
      return { status: 'healthy', schemaVersion: version };
    } finally {
      database.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { status: 'missing', reason: 'live database is missing' };
    return { status: 'inaccessible', reason: 'live database cannot be inspected' };
  }
};

export const inspectVocabularyRecovery = async (
  filePath: string,
  coordinator: VocabularyBackupCoordinator,
): Promise<VocabularyRecoveryInspection> => {
  const live = inspectLiveVocabularyDatabase(filePath);
  const operationRoot = join(dirname(filePath), 'vocabulary-restore-operations');
  let interruptedRestore = false;
  try {
    for (const operation of await readdir(operationRoot)) {
      try {
        const record = JSON.parse(
          await readFile(join(operationRoot, operation, 'restore.json'), 'utf8'),
        ) as { state?: unknown };
        if (record.state === 'started') interruptedRestore = true;
      } catch {
        interruptedRestore = true;
      }
    }
  } catch {
    /* no restore-operation directory is the normal case */
  }
  const artifacts = await coordinator.inventory();
  const validBackupCount = artifacts.filter(
    (artifact) => artifact.status === 'valid-published',
  ).length;
  const invalidArtifacts = artifacts.some(
    (artifact) => !['valid-published', 'quarantined'].includes(artifact.status),
  );
  const decision: VocabularyRecoveryDecision =
    live.status === 'healthy'
      ? 'normal'
      : live.status === 'missing' && validBackupCount === 0
        ? 'normal'
        : validBackupCount > 0
          ? 'recovery-required'
          : 'blocked';
  return {
    live,
    artifacts,
    validBackupCount,
    interruptedRestore,
    decision: interruptedRestore
      ? 'recovery-required'
      : invalidArtifacts && live.status === 'healthy'
        ? 'normal'
        : decision,
  };
};
