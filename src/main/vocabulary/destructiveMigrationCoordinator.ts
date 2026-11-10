import type { DatabaseSync } from 'node:sqlite';
import {
  applyMigrationBody,
  pendingMigrations,
  type MigrationOutcome,
  type MigrationStep,
  readSchemaVersion,
} from './schema';
import { classifyDatabaseError } from './connection';
import type {
  VocabularyBackupCoordinator,
  VocabularyBackupManifest,
} from './vocabularyBackupCoordinator';

export const DEFAULT_MIGRATION_RETRIES = 3;

export interface DestructiveMigrationCoordinatorOptions {
  readonly backup: VocabularyBackupCoordinator;
  readonly maxRetries?: number;
  readonly onDiagnostic?: (message: string) => void;
  /** Deterministic verification hooks; production supplies none. */
  readonly onInitialVersion?: (version: number) => void | Promise<void>;
  readonly onBackupValidated?: () => void | Promise<void>;
  readonly onReservationAcquired?: () => void | Promise<void>;
}

export interface DestructiveMigrationResult {
  readonly migration: MigrationOutcome;
  readonly backups: readonly VocabularyBackupManifest[];
}

const dataVersion = (database: DatabaseSync): number => {
  const row = database.prepare('PRAGMA data_version').get() as
    { data_version?: unknown } | undefined;
  if (typeof row?.data_version !== 'number') throw new Error('could not read data_version');
  return row.data_version;
};

const rollback = (database: DatabaseSync): void => {
  try {
    database.exec('ROLLBACK');
  } catch {
    /* preserve original failure */
  }
};

/** Executes pending migrations only after a verified backup for each rewriting step. */
export const migrateWithVerifiedBackups = async (
  database: DatabaseSync,
  {
    backup,
    maxRetries = DEFAULT_MIGRATION_RETRIES,
    onDiagnostic = (): void => {},
    onInitialVersion,
    onBackupValidated,
    onReservationAcquired,
  }: DestructiveMigrationCoordinatorOptions,
  stepsOverride?: readonly MigrationStep[],
): Promise<DestructiveMigrationResult> => {
  if (!Number.isInteger(maxRetries) || maxRetries < 1)
    throw new Error('migration retry limit must be positive');
  const steps = stepsOverride ?? pendingMigrations(database);
  const backups: VocabularyBackupManifest[] = [];
  const from = readSchemaVersion(database);
  let rewroteData = false;

  for (const step of steps) {
    let completed = false;
    for (let attempt = 1; attempt <= maxRetries && !completed; attempt += 1) {
      const initialVersion = dataVersion(database);
      await onInitialVersion?.(initialVersion);
      let verified: VocabularyBackupManifest | null = null;
      try {
        if (step.rewritesData) {
          verified = await backup.create(database);
          await onBackupValidated?.();
          // The backup is independently verified before this point. A fresh
          // data_version observation is mandatory for every retry.
          if (dataVersion(database) !== initialVersion) {
            onDiagnostic(`migration backup became stale before reservation (attempt ${attempt})`);
            continue;
          }
        }
        database.exec('BEGIN IMMEDIATE');
        await onReservationAcquired?.();
        if (dataVersion(database) !== initialVersion) {
          rollback(database);
          onDiagnostic(`migration source changed before reservation (attempt ${attempt})`);
          continue;
        }
        applyMigrationBody(database, step);
        database.exec('COMMIT');
        if (verified !== null) backups.push(verified);
        rewroteData ||= step.rewritesData;
        completed = true;
      } catch (error) {
        rollback(database);
        const reason = classifyDatabaseError(error);
        if ((reason === 'locked' || reason === 'unknown') && attempt < maxRetries) {
          onDiagnostic(`migration attempt ${attempt} retrying after ${reason}`);
          continue;
        }
        throw error;
      }
    }
    if (!completed) throw new Error(`migration retry limit exhausted at version ${step.version}`);
  }

  return {
    migration: {
      from,
      to: steps.length === 0 ? from : steps[steps.length - 1]!.version,
      rewroteData,
    },
    backups,
  };
};
