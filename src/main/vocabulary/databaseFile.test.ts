import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  VOCABULARY_FILE_NAME,
  corruptDatabasePath,
  setAsideCorruptDatabase,
  vocabularyDatabasePath,
  type DatabaseFiles,
} from './databaseFile';

/** The path is composed here, and a damaged file is moved, never deleted. */

describe('where the database lives', () => {
  it('is a fixed name inside the profile directory', () => {
    expect(vocabularyDatabasePath('/home/someone/.config/app')).toBe(
      join('/home/someone/.config/app', VOCABULARY_FILE_NAME),
    );
  });
});

describe('the name a damaged database is moved to', () => {
  it('carries the moment it happened and keeps the extension', () => {
    expect(
      corruptDatabasePath('/profile/vocabulary.db', new Date('2026-10-02T09:15:00.000Z')),
    ).toBe('/profile/vocabulary.corrupt-2026-10-02T09-15-00.000Z.db');
  });

  it('has no colon in it, because Windows will not have one', () => {
    expect(corruptDatabasePath('/profile/vocabulary.db', new Date())).not.toContain(':');
  });
});

describe('setting a damaged database aside', () => {
  const files = (existing: readonly string[]): DatabaseFiles & { renames: string[][] } => {
    const renames: string[][] = [];

    return {
      renames,
      rename: (from, to): void => {
        renames.push([from, to]);
      },
      exists: (path): boolean => existing.includes(path),
    };
  };

  it('renames the file rather than deleting it', () => {
    const disk = files([]);
    const outcome = setAsideCorruptDatabase(
      '/profile/vocabulary.db',
      disk,
      new Date('2026-10-02T09:15:00.000Z'),
    );

    expect(disk.renames).toEqual([
      ['/profile/vocabulary.db', '/profile/vocabulary.corrupt-2026-10-02T09-15-00.000Z.db'],
    ]);
    expect(outcome.movedTo).toBe('/profile/vocabulary.corrupt-2026-10-02T09-15-00.000Z.db');
  });

  it('takes the write-ahead log with it', () => {
    const disk = files(['/profile/vocabulary.db-wal', '/profile/vocabulary.db-shm']);
    const outcome = setAsideCorruptDatabase(
      '/profile/vocabulary.db',
      disk,
      new Date('2026-10-02T09:15:00.000Z'),
    );

    expect(outcome.companions).toHaveLength(2);
    expect(disk.renames).toHaveLength(3);
  });

  it('refuses to write over a database that was already set aside', () => {
    const at = new Date('2026-10-02T09:15:00.000Z');
    const disk = files([corruptDatabasePath('/profile/vocabulary.db', at)]);
    const rename = vi.spyOn(disk, 'rename');

    expect(() => setAsideCorruptDatabase('/profile/vocabulary.db', disk, at)).toThrow();
    expect(rename).not.toHaveBeenCalled();
  });
});
