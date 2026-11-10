import { join } from 'node:path';

/**
 * Where the vocabulary database lives, and what may be done to the file.
 *
 * The path is composed here from the application's own profile directory
 * and a fixed file name. No part of it is ever supplied by a renderer: the
 * IPC surface carries words and ids, never file paths (ADR-021).
 */

export const VOCABULARY_FILE_NAME = 'vocabulary.db';

export const vocabularyDatabasePath = (userDataDirectory: string): string =>
  join(userDataDirectory, VOCABULARY_FILE_NAME);

/**
 * The name a damaged database is moved aside to, never over.
 *
 * The timestamp makes a second attempt on another day keep the first
 * casualty instead of overwriting it; colons are not legal in a Windows
 * file name, so the ISO form is flattened.
 */
export const corruptDatabasePath = (filePath: string, at: Date): string => {
  const stamp = at.toISOString().replaceAll(':', '-');

  return `${filePath.replace(/\.db$/u, '')}.corrupt-${stamp}.db`;
};

export interface DatabaseFiles {
  rename(from: string, to: string): void;
  exists(path: string): boolean;
}

export interface SetAsideOutcome {
  /** Where the damaged file was moved. Main-process diagnostics only. */
  readonly movedTo: string;
  /** Companion WAL and shared-memory files that went with it. */
  readonly companions: readonly string[];
}

/**
 * Moves a damaged database aside, after the reader has said to.
 *
 * Never called on the strength of a `corrupt` verdict alone: a corrupt
 * database is still the reader's vocabulary, and a hundred saved words are
 * worth more than a clean start they did not ask for. The caller is
 * responsible for having obtained that confirmation; this function only
 * refuses to destroy anything, by renaming rather than deleting and by
 * never writing over an existing file.
 */
export const setAsideCorruptDatabase = (
  filePath: string,
  files: DatabaseFiles,
  at: Date,
): SetAsideOutcome => {
  const target = corruptDatabasePath(filePath, at);

  if (files.exists(target)) {
    throw new Error('a database has already been set aside with this name');
  }

  files.rename(filePath, target);

  const companions: string[] = [];

  for (const suffix of ['-wal', '-shm']) {
    const companion = `${filePath}${suffix}`;

    if (files.exists(companion)) {
      files.rename(companion, `${target}${suffix}`);
      companions.push(`${target}${suffix}`);
    }
  }

  return { movedTo: target, companions };
};
