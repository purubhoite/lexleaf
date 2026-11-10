import { DatabaseSync } from 'node:sqlite';

import type { SaveWordRequest, SavedDocumentFacts, SavedWord } from '@core/vocabulary/types';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createExplanationStore,
  type ExplanationStore,
  type NewExplanation,
} from './explanationStore';
import { migrate } from './schema';
import { createSqliteVocabularyRepository } from './sqliteVocabularyRepository';
import { createVocabularyService } from './vocabularyService';

/**
 * Explanation persistence, against a real in-memory database built by the
 * shipped schema module. No DDL is pasted, and no provider is involved:
 * every explanation here is a string a test wrote.
 */

const essays: SavedDocumentFacts = {
  id: 'doc-1',
  name: 'Essays.pdf',
  path: '/books/Essays.pdf',
  pageCount: 300,
  sizeBytes: 2048,
};

const attribution = {
  datasetName: 'Open English WordNet',
  release: '2024',
  licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
  modified: true,
  modificationStatement: 'Transformed.',
  credits: ['Princeton University'],
};

const saveRequest = (page: number, withSource: boolean): SaveWordRequest => ({
  word: { raw: 'charge', display: 'charge', normalized: 'charge', joinedAcrossLines: false },
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
  source: withSource
    ? {
        provider: 'wordnet',
        datasetName: 'Open English WordNet',
        datasetRelease: '2024',
        transformVersion: 'build-7',
        attribution,
      }
    : null,
  document: essays,
  occurrence: {
    page,
    charStart: 10,
    charEnd: 16,
    pageOffsetFraction: 0.4,
    context: 'The capacitor holds a charge.',
    contextWordStart: 22,
  },
});

interface Built {
  readonly database: DatabaseSync;
  readonly store: ExplanationStore;
  readonly service: ReturnType<typeof createVocabularyService>;
  readonly save: (page: number, withSource?: boolean) => SavedWord;
  tick: (iso: string) => void;
}

let open: DatabaseSync[] = [];

const build = (): Built => {
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });

  open.push(database);
  migrate(database);

  let clock = '2026-01-01T00:00:00.000Z';
  let ids = 0;
  const repository = createSqliteVocabularyRepository({ database, now: () => clock });
  const store = createExplanationStore({
    database,
    now: () => clock,
    newId: () => {
      ids += 1;

      return `explanation-${String(ids)}`;
    },
  });
  const service = createVocabularyService({
    open: () => repository,
    openExplanations: () => store,
  });

  return {
    database,
    store,
    service,
    save: (page, withSource = true) => repository.save(saveRequest(page, withSource)),
    tick: (iso: string): void => {
      clock = iso;
    },
  };
};

afterEach(() => {
  for (const database of open) {
    try {
      database.close();
    } catch {
      // Closed by the test.
    }
  }

  open = [];
});

const entry = (itemId: string, overrides: Partial<NewExplanation> = {}): NewExplanation => ({
  itemId,
  documentId: 'doc-1',
  page: 10,
  contextHash: 'a'.repeat(64),
  promptVersion: 'ctx-explain-1',
  providerId: 'openai-compatible:0123456789abcdef',
  modelId: 'model-a',
  explanation: 'Here it means an amount of electricity.',
  senseIndex: 0,
  truncated: false,
  ...overrides,
});

const countFor = (database: DatabaseSync, itemId: string): number =>
  (
    database
      .prepare('SELECT count(*) AS n FROM vocabulary_explanations WHERE item_id = ?')
      .get(itemId) as { n: number }
  ).n;

describe('storing an explanation', () => {
  it('returns the row it wrote, with the clock and id it was given', () => {
    const built = build();
    const item = built.save(10);
    const stored = built.store.insert(entry(item.id));

    expect(stored).toMatchObject({
      id: 'explanation-1',
      itemId: item.id,
      documentId: 'doc-1',
      page: 10,
      explanation: 'Here it means an amount of electricity.',
      senseIndex: 0,
      truncated: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('records which dictionary artifact produced the senses', () => {
    const built = build();
    const item = built.save(10);
    const stored = built.store.insert(entry(item.id));
    const joined = built.database
      .prepare(
        `SELECT sources.transform_version AS version
         FROM vocabulary_explanations e
         JOIN dictionary_sources sources ON sources.id = e.source_id
         WHERE e.id = ?`,
      )
      .get(stored?.id ?? '') as { version?: unknown } | undefined;

    expect(typeof stored?.sourceId).toBe('number');
    expect(joined?.['version']).toBe('build-7');
  });

  it('stores no source when the saved word has none', () => {
    const built = build();
    const item = built.save(10, false);

    expect(built.store.insert(entry(item.id))?.sourceId).toBeNull();
  });

  it('keeps two pages apart', () => {
    const built = build();
    const item = built.save(10);

    built.save(84);
    built.store.insert(entry(item.id, { page: 10 }));
    built.store.insert(entry(item.id, { page: 84, contextHash: 'b'.repeat(64) }));

    expect(countFor(built.database, item.id)).toBe(2);
  });

  it('keeps two excerpts on one page apart', () => {
    const built = build();
    const item = built.save(10);

    built.store.insert(entry(item.id, { contextHash: 'a'.repeat(64) }));
    built.store.insert(entry(item.id, { contextHash: 'b'.repeat(64) }));

    expect(countFor(built.database, item.id)).toBe(2);
  });

  it('writes one row when the same question is asked twice', () => {
    const built = build();
    const item = built.save(10);
    const first = built.store.insert(entry(item.id));

    built.tick('2026-02-02T00:00:00.000Z');

    const second = built.store.insert(entry(item.id, { explanation: 'A different wording.' }));

    expect(countFor(built.database, item.id)).toBe(1);
    // The stored row is the one that was already answered: an immutable
    // row is never rewritten by a repeat question.
    expect(second?.id).toBe(first?.id);
    expect(second?.explanation).toBe('Here it means an amount of electricity.');
  });

  it('does not touch the dictionary snapshot', () => {
    const built = build();
    const item = built.save(10);
    const before = built.database
      .prepare('SELECT snapshot_json FROM vocabulary_items WHERE id = ?')
      .get(item.id) as { snapshot_json: string };

    built.store.insert(entry(item.id));

    const after = built.database
      .prepare('SELECT snapshot_json FROM vocabulary_items WHERE id = ?')
      .get(item.id) as { snapshot_json: string };

    expect(after.snapshot_json).toBe(before.snapshot_json);
  });
});

describe('finding an explanation', () => {
  it('answers only when every identity dimension matches', () => {
    const built = build();
    const item = built.save(10);

    built.store.insert(entry(item.id));

    expect(built.store.findExact(entry(item.id))?.explanation).toBe(
      'Here it means an amount of electricity.',
    );
  });

  it.each([
    ['the context hash', { contextHash: 'c'.repeat(64) }],
    ['the prompt version', { promptVersion: 'ctx-explain-2' }],
    ['the provider', { providerId: 'openai-compatible:fedcba9876543210' }],
    ['the model', { modelId: 'model-b' }],
    ['the page', { page: 11 }],
    ['the document', { documentId: 'doc-2' }],
  ])('is not a hit when %s differs', (_label, overrides: Partial<NewExplanation>) => {
    const built = build();
    const item = built.save(10);

    built.store.insert(entry(item.id));

    expect(built.store.findExact(entry(item.id, overrides))).toBeNull();
  });

  it('can still disclose the newest row for the occurrence, separately', () => {
    const built = build();
    const item = built.save(10);

    built.store.insert(entry(item.id, { explanation: 'For the old excerpt.' }));
    built.tick('2026-03-03T00:00:00.000Z');
    built.store.insert(entry(item.id, { contextHash: 'd'.repeat(64), explanation: 'Newer.' }));

    expect(
      built.store.findPrevious({ itemId: item.id, documentId: 'doc-1', page: 10 })?.explanation,
    ).toBe('Newer.');
  });

  it('lists everything stored for one word, oldest first', () => {
    const built = build();
    const item = built.save(10);

    built.store.insert(entry(item.id, { explanation: 'First.' }));
    built.tick('2026-03-03T00:00:00.000Z');
    built.store.insert(entry(item.id, { contextHash: 'e'.repeat(64), explanation: 'Second.' }));

    expect(built.store.listForItem(item.id).map((row) => row.explanation)).toEqual([
      'First.',
      'Second.',
    ]);
  });
});

describe('removing a saved word', () => {
  it('takes its explanations with it', () => {
    const built = build();
    const item = built.save(10);

    built.store.insert(entry(item.id));
    built.service.remove(item.id);

    expect(countFor(built.database, item.id)).toBe(0);
  });

  /**
   * The acceptance case from the investigation (section 6.5): save,
   * explain, remove, undo - and the explanation must come back as the same
   * bytes, not as a new one.
   */
  it('restores every explanation byte for byte on undo', () => {
    const built = build();
    const item = built.save(10);

    built.store.insert(
      entry(item.id, { explanation: 'An explanation with "quotes" and ünïcode.' }),
    );
    built.store.insert(
      entry(item.id, { contextHash: 'f'.repeat(64), senseIndex: null, truncated: true }),
    );

    const before = built.store.listForItem(item.id);

    built.tick('2027-12-31T23:59:59.000Z');

    expect(built.service.remove(item.id).ok).toBe(true);
    expect(countFor(built.database, item.id)).toBe(0);
    expect(built.service.restore(item.id).ok).toBe(true);

    const after = built.store.listForItem(item.id);

    expect(after).toEqual(before);
    // Nothing was regenerated: the ids and the timestamps are the originals
    // even though the clock moved between removal and undo.
    expect(after.map((row) => row.id)).toEqual(['explanation-1', 'explanation-2']);
    expect(after.every((row) => row.createdAt === '2026-01-01T00:00:00.000Z')).toBe(true);
  });

  it('restores the word itself unchanged alongside them', () => {
    const built = build();
    const item = built.save(10);

    built.store.insert(entry(item.id));
    built.service.remove(item.id);
    built.service.restore(item.id);

    const restored = built.database
      .prepare('SELECT created_at FROM vocabulary_items WHERE id = ?')
      .get(item.id) as { created_at: string };

    expect(restored.created_at).toBe('2026-01-01T00:00:00.000Z');
  });

  /**
   * All or nothing: a reader must never get the word back without its
   * explanations, or with only some of them.
   */
  it('restores nothing at all when one explanation cannot be written', () => {
    const built = build();
    const item = built.save(10);

    built.store.insert(entry(item.id));

    // The same database and the same capture, but the explanation half of
    // the restore fails part way through.
    const failing = createVocabularyService({
      open: () => createSqliteVocabularyRepository({ database: built.database }),
      openExplanations: () => ({
        ...built.store,
        restoreMany: (): void => {
          throw new Error('disk full');
        },
      }),
    });

    expect(failing.remove(item.id).ok).toBe(true);
    expect(failing.restore(item.id)).toEqual({ ok: false, error: { kind: 'write-failed' } });

    const items = built.database
      .prepare('SELECT count(*) AS n FROM vocabulary_items WHERE id = ?')
      .get(item.id) as { n: number };

    expect(items.n).toBe(0);
    expect(countFor(built.database, item.id)).toBe(0);
  });
});

describe('what is never stored', () => {
  it('has no column for a failure, a prompt or an excerpt', () => {
    const built = build();
    const columns = (
      built.database.prepare('PRAGMA table_info(vocabulary_explanations)').all() as {
        name: string;
      }[]
    ).map((column) => column.name);

    expect(columns.sort()).toEqual([
      'context_hash',
      'created_at',
      'document_id',
      'explanation',
      'id',
      'item_id',
      'model_id',
      'page',
      'prompt_version',
      'provider_id',
      'sense_index',
      'source_id',
      'truncated',
    ]);
  });
});
