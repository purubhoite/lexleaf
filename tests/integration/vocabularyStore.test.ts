import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SaveWordRequest } from '../../src/core/vocabulary/types';
import { openWordNetProvider } from '../../src/core/dictionary/wordnet/wordNetFileProvider';
import { openFileArtifact } from '../../src/main/dictionary/fileArtifact';
import { openVocabularyDatabase } from '../../src/main/vocabulary/connection';
import { createSqliteVocabularyRepository } from '../../src/main/vocabulary/sqliteVocabularyRepository';
import { createVocabularyService } from '../../src/main/vocabulary/vocabularyService';
import { vocabularyDatabasePath } from '../../src/main/vocabulary/databaseFile';

/**
 * The vocabulary store on a real filesystem, across a real restart.
 *
 * The unit suite drives the repository against in-memory databases. This
 * file answers the two questions that only a real file can answer: does a
 * saved word survive the application being closed and opened again, still
 * attached to the document it came from; and does a vocabulary database
 * that is missing, unwritable or damaged leave the rest of the
 * application — reading and the dictionary — working.
 *
 * Every database here is built by the shipped schema module through the
 * ordinary open path. No DDL is pasted into this file, so a schema change
 * that the migration does not perform fails here.
 */

const FIXTURE_DICTIONARY = join(__dirname, '../fixtures/dictionary');

let profiles: string[] = [];

const profile = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'vocabulary-'));

  profiles.push(directory);

  return directory;
};

afterEach(() => {
  for (const directory of profiles) {
    try {
      chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Already gone.
    }
  }

  profiles = [];
});

const serviceFor = (
  userData: string,
): ReturnType<typeof createVocabularyService> & { readonly diagnostics: string[] } => {
  const diagnostics: string[] = [];
  const service = createVocabularyService({
    open: () => {
      const opened = openVocabularyDatabase({
        filePath: vocabularyDatabasePath(userData),
        onDiagnostic: (message) => diagnostics.push(message),
      });

      return createSqliteVocabularyRepository({ database: opened.database });
    },
    onDiagnostic: (message) => diagnostics.push(message),
  });

  return Object.assign(service, { diagnostics });
};

const saving = (page: number): SaveWordRequest => ({
  word: { raw: 'mice', display: 'mice', normalized: 'mice', joinedAcrossLines: false },
  document: {
    id: 'content-id-1',
    name: 'Essays.pdf',
    path: '/books/Essays.pdf',
    pageCount: 300,
    sizeBytes: 2048,
  },
  occurrence: {
    page,
    charStart: 10,
    charEnd: 14,
    pageOffsetFraction: 0.5,
    context: 'the mice scattered across the floor',
    contextWordStart: 4,
  },
  headword: 'mouse',
  resolvedBy: 'morphology',
  lookupStatus: 'found',
  shortDefinition: 'small rodents',
  snapshot: {
    senses: [
      {
        partOfSpeech: 'noun',
        definition: 'small rodents',
        examples: [],
        synonyms: [],
        source: 'wordnet',
      },
    ],
    pronunciations: [],
    alsoInflectionOf: [],
  },
  source: {
    provider: 'wordnet',
    datasetName: 'Open English WordNet',
    datasetRelease: '2024',
    transformVersion: '1.0.0',
    attribution: {
      datasetName: 'Open English WordNet',
      release: '2024',
      licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
      modified: true,
      modificationStatement: 'Transformed into the application index.',
      credits: ['Princeton University'],
    },
  },
});

describe('a saved word on a real filesystem', () => {
  it('is still there, and still attached to its document, after a restart', () => {
    const userData = profile();

    const first = serviceFor(userData);
    const saved = first.save(saving(12));

    expect(saved.ok).toBe(true);
    first.close();

    // A second service, a second connection, a second open of the file:
    // as close to restarting the application as a test can get without
    // launching Electron.
    const second = serviceFor(userData);
    const listed = second.list({ sort: 'newest', documentId: null, cursor: null, limit: 50 });

    expect(listed.ok).toBe(true);

    if (!listed.ok) {
      return;
    }

    const item = listed.value.items[0];

    expect(item?.word.normalized).toBe('mice');
    expect(item?.shortDefinition).toBe('small rodents');
    expect(item?.occurrences[0]).toMatchObject({
      documentId: 'content-id-1',
      documentName: 'Essays.pdf',
      page: 12,
      charStart: 10,
      charEnd: 14,
    });

    second.close();
  });

  it('is not created at all until something is saved or asked for', () => {
    const userData = profile();
    const file = vocabularyDatabasePath(userData);

    serviceFor(userData);

    // Starting the application is not a reason to create a database.
    expect(existsSync(file)).toBe(false);

    const service = serviceFor(userData);
    service.documents();

    expect(existsSync(file)).toBe(true);
    service.close();
  });

  it('folds a repeated save of the same page into one occurrence across restarts', () => {
    const userData = profile();

    const first = serviceFor(userData);
    first.save(saving(12));
    first.close();

    const second = serviceFor(userData);
    const again = second.save(saving(12));

    expect(again.ok).toBe(true);

    if (again.ok) {
      expect(again.value.occurrences).toHaveLength(1);
      expect(again.value.occurrenceCount).toBe(1);
    }

    second.close();
  });
});

describe('when the vocabulary database cannot be used', () => {
  it('says so by reason, with no filesystem path in the answer', () => {
    const userData = profile();

    writeFileSync(vocabularyDatabasePath(userData), 'this is not a database at all');

    const service = serviceFor(userData);
    const listed = service.list({ sort: 'newest', documentId: null, cursor: null, limit: 50 });

    expect(listed.ok).toBe(false);

    if (listed.ok) {
      return;
    }

    expect(listed.error).toEqual({ kind: 'unavailable', reason: 'not-a-database' });
    expect(JSON.stringify(listed.error)).not.toContain(userData);
  });

  it('leaves a damaged file exactly where it was, and does not discard it', () => {
    const userData = profile();
    const file = vocabularyDatabasePath(userData);

    writeFileSync(file, 'not a database');

    const service = serviceFor(userData);
    service.list({ sort: 'newest', documentId: null, cursor: null, limit: 50 });

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('not a database');
  });

  it('leaves the dictionary answering: a reader can still look words up', () => {
    const userData = profile();

    writeFileSync(vocabularyDatabasePath(userData), 'not a database');

    const service = serviceFor(userData);
    const failed = service.list({ sort: 'newest', documentId: null, cursor: null, limit: 50 });

    expect(failed.ok).toBe(false);

    // The dictionary is a different subsystem reading different files, and
    // a broken vocabulary store must not reach it.
    const provider = openWordNetProvider(openFileArtifact(FIXTURE_DICTIONARY));
    const result = provider.lookUp({ normalized: 'mice', raw: 'mice', joinedAcrossLines: false });

    expect(result.status).not.toBe('unavailable');
  });

  it('reports an unwritable profile directory without throwing', () => {
    const userData = profile();

    // A regular file at the profile path deterministically blocks SQLite
    // creation on both POSIX and Windows; chmod is not portable ACL coverage.
    rmSync(userData, { recursive: true, force: true });
    writeFileSync(userData, 'profile path is a file');

    const service = serviceFor(userData);
    const saved = service.save(saving(12));

    expect(saved.ok).toBe(false);

    if (!saved.ok) {
      expect(saved.error.kind).toBe('unavailable');
    }

    chmodSync(userData, 0o700);
  });
});
