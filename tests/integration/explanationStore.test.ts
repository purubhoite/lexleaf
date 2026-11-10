import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { SaveWordRequest } from '../../src/core/vocabulary/types';
import { openVocabularyDatabase } from '../../src/main/vocabulary/connection';
import { vocabularyDatabasePath } from '../../src/main/vocabulary/databaseFile';
import { createExplanationStore } from '../../src/main/vocabulary/explanationStore';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../src/main/vocabulary/schema';
import { createSqliteVocabularyRepository } from '../../src/main/vocabulary/sqliteVocabularyRepository';
import { createVocabularyService } from '../../src/main/vocabulary/vocabularyService';

/**
 * Explanations on a real filesystem, across a real restart and a real
 * upgrade.
 *
 * The unit suite drives the store against in-memory databases. Three
 * questions need a file on disk: does an explanation survive the
 * application being closed and opened again; does a database written by
 * Milestone 4 upgrade in place without losing a row; and does removing a
 * word and undoing it put the explanations back exactly as they were.
 *
 * Every database here is built by the shipped schema module through the
 * ordinary open path. No DDL is pasted into this file.
 */

let profiles: string[] = [];

const profile = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'explanations-'));

  profiles.push(directory);

  return directory;
};

afterEach(() => {
  for (const directory of profiles) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Already gone.
    }
  }

  profiles = [];
});

const saving = (page: number): SaveWordRequest => ({
  word: { raw: 'charge', display: 'charge', normalized: 'charge', joinedAcrossLines: false },
  document: {
    id: 'content-id-1',
    name: 'Physics.pdf',
    path: '/books/Physics.pdf',
    pageCount: 300,
    sizeBytes: 4096,
  },
  occurrence: {
    page,
    charStart: 22,
    charEnd: 28,
    pageOffsetFraction: 0.5,
    context: 'The capacitor holds a charge for several minutes.',
    contextWordStart: 22,
  },
  headword: 'charge',
  resolvedBy: 'exact',
  lookupStatus: 'found',
  shortDefinition: 'a quantity of electricity',
  snapshot: {
    senses: [
      {
        partOfSpeech: 'noun',
        definition: 'a quantity of electricity',
        examples: [],
        synonyms: [],
        source: 'wordnet',
      },
    ],
    pronunciations: [],
    alsoInflectionOf: [],
  },
  source: null,
});

const explanationFor = (
  itemId: string,
  contextHash = 'hash-1',
): Parameters<ReturnType<typeof createExplanationStore>['insert']>[0] => ({
  itemId,
  documentId: 'content-id-1',
  page: 12,
  contextHash,
  promptVersion: 'ctx-explain-1',
  providerId: 'openai-compatible:0123456789abcdef',
  modelId: 'model-a',
  explanation: 'Here it means stored electricity.',
  senseIndex: 0,
  truncated: false,
});

const openProfile = (
  userData: string,
): {
  readonly database: DatabaseSync;
  readonly store: ReturnType<typeof createExplanationStore>;
  readonly repository: ReturnType<typeof createSqliteVocabularyRepository>;
} => {
  const opened = openVocabularyDatabase({ filePath: vocabularyDatabasePath(userData) });

  return {
    database: opened.database,
    store: createExplanationStore({ database: opened.database }),
    repository: createSqliteVocabularyRepository({ database: opened.database }),
  };
};

describe('an explanation on a real filesystem', () => {
  it('is still there after a restart, with its word and its provenance', () => {
    const userData = profile();

    const first = openProfile(userData);
    const saved = first.repository.save(saving(12));

    first.store.insert(explanationFor(saved.id));
    first.database.close();

    const second = openProfile(userData);
    const rows = second.store.listForItem(saved.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.explanation).toBe('Here it means stored electricity.');
    expect(rows[0]?.providerId).toBe('openai-compatible:0123456789abcdef');
    expect(rows[0]?.promptVersion).toBe('ctx-explain-1');

    second.database.close();
  });

  it('asks the same question twice without writing a second row', () => {
    const userData = profile();
    const { database, repository, store } = openProfile(userData);
    const saved = repository.save(saving(12));

    const once = store.insert(explanationFor(saved.id));
    const twice = store.insert(explanationFor(saved.id));

    expect(once?.id).toBe(twice?.id);
    expect(store.listForItem(saved.id)).toHaveLength(1);

    database.close();
  });

  it('leaves the dictionary snapshot exactly as the dictionary wrote it', () => {
    const userData = profile();
    const { database, repository, store } = openProfile(userData);
    const saved = repository.save(saving(12));

    const before = database
      .prepare('SELECT snapshot_json FROM vocabulary_items WHERE id = ?')
      .get(saved.id) as { snapshot_json: string };

    store.insert(explanationFor(saved.id));

    const after = database
      .prepare('SELECT snapshot_json FROM vocabulary_items WHERE id = ?')
      .get(saved.id) as { snapshot_json: string };

    expect(after.snapshot_json).toBe(before.snapshot_json);
    expect(after.snapshot_json).not.toContain('stored electricity');

    database.close();
  });
});

describe('a Milestone 4 database', () => {
  it('upgrades in place, keeping every row it had', () => {
    const userData = profile();
    const filePath = vocabularyDatabasePath(userData);

    // A real version 1 file, written by the shipped version 1 migration.
    const old = new DatabaseSync(filePath);

    MIGRATIONS[0]?.apply(old);
    old.exec('PRAGMA user_version = 1');

    const beforeUpgrade = createSqliteVocabularyRepository({ database: old }).save(saving(12));

    old.close();

    const opened = openVocabularyDatabase({ filePath });

    expect(opened.migration).toMatchObject({ from: 1, to: CURRENT_SCHEMA_VERSION });

    const store = createExplanationStore({ database: opened.database });

    expect(store.listForItem(beforeUpgrade.id)).toEqual([]);

    store.insert(explanationFor(beforeUpgrade.id));

    expect(store.listForItem(beforeUpgrade.id)).toHaveLength(1);

    opened.database.close();
  });
});

describe('removing a word and changing your mind', () => {
  it('takes the explanations away and puts them back unchanged', () => {
    const userData = profile();
    const filePath = vocabularyDatabasePath(userData);
    let handle: DatabaseSync | null = null;

    const database = (): DatabaseSync => {
      handle ??= openVocabularyDatabase({ filePath }).database;

      return handle;
    };

    const service = createVocabularyService({
      open: () => createSqliteVocabularyRepository({ database: database() }),
      openExplanations: () => createExplanationStore({ database: database() }),
    });

    const saved = service.save(saving(12));

    expect(saved.ok).toBe(true);

    const itemId = saved.ok ? saved.value.id : '';
    const store = createExplanationStore({ database: database() });
    const written = store.insert(explanationFor(itemId));

    expect(service.remove(itemId).ok).toBe(true);
    expect(store.listForItem(itemId)).toEqual([]);

    expect(service.restore(itemId).ok).toBe(true);

    const restored = store.listForItem(itemId);

    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual(written);

    service.close();
  });
});
