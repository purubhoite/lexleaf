import { DatabaseSync } from 'node:sqlite';

import type { VocabularyUnavailableReason } from '@core/vocabulary/types';

import {
  MigrationFailedError,
  SchemaTooNewError,
  migrate,
  readSchemaVersion,
  type MigrationOutcome,
} from './schema';

/**
 * Opening the vocabulary database, and deciding what a failure means.
 *
 * Everything here is about the moment of opening: the pragmas that make the
 * file behave (WAL, foreign keys, a bounded busy timeout), the integrity
 * check, the migration, and the translation of a driver error into one of
 * the reasons the rest of the application is allowed to see.
 *
 * Two rules hold without exception:
 *
 * - **A damaged database is never discarded here.** `quick_check` failing
 *   produces a `corrupt` failure and the file is left exactly as it is. Only
 *   an explicit instruction from the reader moves it aside, and that lives
 *   in the service.
 * - **No path leaves this module inside a reason.** Driver messages are
 *   kept for the main-process log only. The investigation measured that
 *   `node:sqlite` does not put the filename in its messages; this module
 *   does not rely on that, it simply never forwards them.
 */

/** SQLite result codes this module distinguishes. */
const SQLITE_CANTOPEN = 14;
const SQLITE_NOTADB = 26;
const SQLITE_READONLY = 8;
const SQLITE_BUSY = 5;
const SQLITE_CORRUPT = 11;

/**
 * How long a statement waits for another writer before failing.
 *
 * Bounded on purpose: one window of one application should never contend
 * for long, so a wait this long means something is wrong and the reader is
 * better told than left with a frozen library.
 */
export const BUSY_TIMEOUT_MS = 2_000;

export class VocabularyOpenError extends Error {
  constructor(
    readonly reason: VocabularyUnavailableReason,
    /** Main-process diagnostics only. Never crosses an IPC boundary. */
    readonly detail: string,
  ) {
    super(`vocabulary database unavailable: ${reason}`);
    this.name = 'VocabularyOpenError';
  }
}

const errorCodeOf = (error: unknown): number | null => {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const code = (error as { errcode?: unknown }).errcode;

  return typeof code === 'number' ? code : null;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Translates anything thrown while opening or using the database.
 *
 * Exported for its own unit tests: the mapping matters more than the code
 * that calls it.
 */
export const classifyDatabaseError = (error: unknown): VocabularyUnavailableReason => {
  if (error instanceof SchemaTooNewError) {
    return 'schema-too-new';
  }

  if (error instanceof MigrationFailedError) {
    return 'migration-failed';
  }

  if (error instanceof VocabularyOpenError) {
    return error.reason;
  }

  const message = messageOf(error).toLowerCase();

  switch (errorCodeOf(error)) {
    case SQLITE_NOTADB:
      return 'not-a-database';
    case SQLITE_CANTOPEN:
    case SQLITE_READONLY:
      return 'not-writable';
    case SQLITE_BUSY:
      return 'locked';
    case SQLITE_CORRUPT:
      return 'corrupt';
    default:
      break;
  }

  if (message.includes('malformed') || message.includes('corrupt')) {
    return 'corrupt';
  }

  if (message.includes('database is locked') || message.includes('busy')) {
    return 'locked';
  }

  if (message.includes('readonly') || message.includes('unable to open')) {
    return 'not-writable';
  }

  return 'unknown';
};

export interface OpenedDatabase {
  readonly database: DatabaseSync;
  readonly migration: MigrationOutcome;
}

export interface OpenOptions {
  readonly filePath: string;
  /** Called when a migration step that rewrites data is about to run. */
  readonly onBackup?: (version: number) => void;
  /** Main-process diagnostics. */
  readonly onDiagnostic?: (message: string) => void;
  /** Stage 4 runtime preparation performs migrations asynchronously. */
  readonly migrate?: boolean;
}

const applyPragmas = (database: DatabaseSync): void => {
  database.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA foreign_keys = ON');
};

/**
 * `quick_check` rather than `integrity_check`.
 *
 * Measured on a ten-thousand-item database: 3.4 ms against 11.5 ms, for the
 * same verdict on the damage this check exists to catch. It runs on every
 * open because the alternative is discovering the damage halfway through a
 * write.
 */
const verifyIntegrity = (database: DatabaseSync): void => {
  const row = database.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined;
  const verdict = row?.['quick_check'];

  if (verdict !== 'ok') {
    throw new VocabularyOpenError('corrupt', `quick_check returned ${String(verdict)}`);
  }
};

/**
 * Opens the database, checks it, and migrates it to the current version.
 *
 * Throws `VocabularyOpenError` and nothing else: every caller gets a reason
 * it can act on rather than a driver exception it has to interpret.
 */
export const openVocabularyDatabase = ({
  filePath,
  onBackup,
  onDiagnostic,
  migrate: shouldMigrate = true,
}: OpenOptions): OpenedDatabase => {
  let database: DatabaseSync;

  try {
    database = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
  } catch (error) {
    throw new VocabularyOpenError(classifyDatabaseError(error), messageOf(error));
  }

  try {
    applyPragmas(database);
    verifyIntegrity(database);

    const migration = shouldMigrate
      ? migrate(database, onBackup)
      : { from: readSchemaVersion(database), to: readSchemaVersion(database), rewroteData: false };

    if (migration.from !== migration.to) {
      onDiagnostic?.(`vocabulary schema migrated from ${migration.from} to ${migration.to}`);
    }

    return { database, migration };
  } catch (error) {
    try {
      database.close();
    } catch {
      // Closing a database that failed to open properly is best effort.
    }

    throw error instanceof VocabularyOpenError
      ? error
      : new VocabularyOpenError(classifyDatabaseError(error), messageOf(error));
  }
};
