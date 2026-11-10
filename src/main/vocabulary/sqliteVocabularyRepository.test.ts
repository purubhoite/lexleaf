import { DatabaseSync } from 'node:sqlite';

import type {
  SaveWordRequest,
  SavedDocumentFacts,
  VocabularyRepository,
} from '@core/vocabulary/types';
import { afterEach, describe, expect, it } from 'vitest';

import { migrate } from './schema';
import { createSqliteVocabularyRepository } from './sqliteVocabularyRepository';

/**
 * The store, exercised against a real in-memory SQLite database built by
 * the shipped schema module. Nothing here pastes DDL.
 */

const attribution = {
  datasetName: 'Open English WordNet',
  release: '2024',
  licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
  modified: true,
  modificationStatement: 'Transformed.',
  credits: ['Princeton University'],
};

const essays: SavedDocumentFacts = {
  id: 'doc-1',
  name: 'Essays.pdf',
  path: '/books/Essays.pdf',
  pageCount: 300,
  sizeBytes: 2_048,
};

const letters: SavedDocumentFacts = {
  id: 'doc-2',
  name: 'Letters.pdf',
  path: '/books/Letters.pdf',
  pageCount: 120,
  sizeBytes: 1_024,
};

interface Built {
  readonly repository: VocabularyRepository;
  readonly database: DatabaseSync;
  tick: (iso: string) => void;
}

let open: DatabaseSync[] = [];

const build = (): Built => {
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  open.push(database);
  migrate(database);

  let clock = '2026-01-01T00:00:00.000Z';
  const built: Built = {
    database,
    repository: createSqliteVocabularyRepository({ database, now: () => clock }),
    tick: (iso: string): void => {
      clock = iso;
    },
  };

  return built;
};

afterEach(() => {
  for (const database of open) {
    try {
      database.close();
    } catch {
      // Closed by the repository under test.
    }
  }

  open = [];
});

const request = (
  word: string,
  document: SavedDocumentFacts,
  page: number,
  overrides: Partial<SaveWordRequest> = {},
): SaveWordRequest => ({
  word: { raw: word, display: word, normalized: word.toLowerCase(), joinedAcrossLines: false },
  document,
  occurrence: {
    page,
    charStart: null,
    charEnd: null,
    pageOffsetFraction: null,
    context: null,
    contextWordStart: null,
  },
  headword: word.toLowerCase(),
  resolvedBy: 'exact',
  lookupStatus: 'found',
  shortDefinition: `the definition of ${word.toLowerCase()}`,
  snapshot: {
    senses: [
      {
        partOfSpeech: 'noun',
        definition: `the definition of ${word.toLowerCase()}`,
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
    attribution,
  },
  ...overrides,
});

const anchored = (
  word: string,
  document: SavedDocumentFacts,
  page: number,
  charStart: number,
  charEnd: number,
  context: string,
): SaveWordRequest =>
  request(word, document, page, {
    occurrence: {
      page,
      charStart,
      charEnd,
      pageOffsetFraction: 0.5,
      context,
      contextWordStart: 4,
    },
  });

describe('saving a word', () => {
  it('stores the word, the place and the answer that was shown', () => {
    const { repository } = build();
    const saved = repository.save(anchored('Mice', essays, 12, 10, 14, 'the mice scattered'));

    expect(saved.word.normalized).toBe('mice');
    expect(saved.word.display).toBe('Mice');
    expect(saved.shortDefinition).toBe('the definition of mice');
    expect(saved.snapshot?.senses).toHaveLength(1);
    expect(saved.source?.datasetRelease).toBe('2024');
    expect(saved.occurrences).toHaveLength(1);
    expect(saved.occurrences[0]).toMatchObject({
      documentId: 'doc-1',
      documentName: 'Essays.pdf',
      page: 12,
      charStart: 10,
      charEnd: 14,
      context: 'the mice scattered',
    });
  });

  it('saves a word the dictionary had no entry for', () => {
    const { repository } = build();
    const saved = repository.save(
      request('xyzzy', essays, 3, {
        headword: null,
        resolvedBy: null,
        lookupStatus: 'not-found',
        shortDefinition: null,
        snapshot: null,
        source: null,
      }),
    );

    expect(saved.lookupStatus).toBe('not-found');
    expect(saved.snapshot).toBeNull();
    expect(saved.source).toBeNull();
    expect(saved.occurrences).toHaveLength(1);
  });

  it('keeps one item for the same word met in two documents', () => {
    const { repository } = build();
    const first = repository.save(request('mice', essays, 12));
    const second = repository.save(request('mice', letters, 4));

    expect(second.id).toBe(first.id);
    expect(second.occurrences).toHaveLength(2);
    expect(second.occurrenceCount).toBe(2);
  });

  it('does not rewrite the snapshot or the save date when saving elsewhere', () => {
    const { repository, tick } = build();
    const first = repository.save(request('mice', essays, 12));

    tick('2026-06-01T00:00:00.000Z');
    const second = repository.save(
      request('mice', letters, 4, {
        shortDefinition: 'a different definition',
        snapshot: {
          senses: [
            {
              partOfSpeech: 'verb',
              definition: 'a different definition',
              examples: [],
              synonyms: [],
              source: 'wordnet',
            },
          ],
          pronunciations: [],
          alsoInflectionOf: [],
        },
      }),
    );

    expect(second.shortDefinition).toBe(first.shortDefinition);
    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.savedAt).toBe(first.savedAt);
  });
});

describe('one occurrence per word per page', () => {
  it('folds a repeated save with no anchor into the same row', () => {
    const { repository } = build();
    repository.save(request('mice', essays, 12));
    const again = repository.save(request('mice', essays, 12));

    expect(again.occurrences).toHaveLength(1);
    expect(again.occurrenceCount).toBe(1);
  });

  it('fills in an anchor a later save brings, keeping the original date', () => {
    const { repository, tick } = build();
    repository.save(request('mice', essays, 12));

    tick('2026-02-02T00:00:00.000Z');
    const filled = repository.save(anchored('mice', essays, 12, 10, 14, 'the mice scattered'));

    expect(filled.occurrences).toHaveLength(1);
    expect(filled.occurrences[0]).toMatchObject({
      charStart: 10,
      charEnd: 14,
      context: 'the mice scattered',
      savedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('never erases an anchor when a later save of the same page has none', () => {
    const { repository, tick } = build();
    repository.save(anchored('mice', essays, 12, 10, 14, 'the mice scattered'));

    tick('2026-02-02T00:00:00.000Z');
    const second = repository.save(request('mice', essays, 12));

    // Gap-filling runs one way only: a later save may supply what was
    // missing, never take away what was recorded.
    expect(second.occurrences).toHaveLength(1);
    expect(second.occurrences[0]).toMatchObject({
      charStart: 10,
      charEnd: 14,
      context: 'the mice scattered',
      savedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('keeps the first anchor and the first excerpt when a later one differs', () => {
    const { repository } = build();
    repository.save(anchored('mice', essays, 12, 10, 14, 'the mice scattered'));
    const second = repository.save(anchored('mice', essays, 12, 90, 94, 'more mice here'));

    expect(second.occurrences[0]).toMatchObject({
      charStart: 10,
      charEnd: 14,
      context: 'the mice scattered',
    });
  });

  it('treats another page of the same document as another place', () => {
    const { repository } = build();
    repository.save(request('mice', essays, 12));
    const second = repository.save(request('mice', essays, 13));

    expect(second.occurrences.map((occurrence) => occurrence.page)).toEqual([12, 13]);
  });

  it('orders occurrences oldest first, by when they were saved', () => {
    const { repository, tick } = build();
    repository.save(request('mice', essays, 30));
    tick('2026-03-03T00:00:00.000Z');
    repository.save(request('mice', essays, 2));

    expect(
      repository
        .occurrences(
          repository.list({
            sort: 'newest',
            documentId: null,
            cursor: null,
            limit: 10,
          }).items[0]!.id,
        )
        .map((occurrence) => occurrence.page),
    ).toEqual([30, 2]);
  });
});

describe('the state of the save control', () => {
  it('reports not saved, saved here and saved elsewhere', () => {
    const { repository } = build();

    expect(repository.stateForWord({ normalized: 'mice', documentId: 'doc-1', page: 12 })).toEqual({
      state: 'not-saved',
    });

    const saved = repository.save(request('mice', essays, 12));

    expect(repository.stateForWord({ normalized: 'mice', documentId: 'doc-1', page: 12 })).toEqual({
      state: 'saved-here',
      itemId: saved.id,
      otherPlaces: 0,
    });
    expect(repository.stateForWord({ normalized: 'mice', documentId: 'doc-1', page: 13 })).toEqual({
      state: 'saved-elsewhere',
      itemId: saved.id,
      otherPlaces: 1,
    });
    expect(repository.stateForWord({ normalized: 'mice', documentId: 'doc-2', page: 1 })).toEqual({
      state: 'saved-elsewhere',
      itemId: saved.id,
      otherPlaces: 1,
    });
  });

  it('counts the other places a word was met', () => {
    const { repository } = build();
    const saved = repository.save(request('mice', essays, 12));
    repository.save(request('mice', essays, 40));
    repository.save(request('mice', letters, 4));

    expect(repository.stateForWord({ normalized: 'mice', documentId: 'doc-1', page: 12 })).toEqual({
      state: 'saved-here',
      itemId: saved.id,
      otherPlaces: 2,
    });
  });
});

describe('removing and restoring', () => {
  it('removes the word and every place it was met', () => {
    const { repository, database } = build();
    const saved = repository.save(request('mice', essays, 12));
    repository.save(request('mice', letters, 4));

    repository.remove(saved.id);

    expect(
      repository.list({ sort: 'newest', documentId: null, cursor: null, limit: 10 }).items,
    ).toHaveLength(0);
    expect(
      database.prepare('SELECT count(*) AS n FROM vocabulary_occurrences').get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it('puts back exactly what was removed, dates included', () => {
    const { repository, tick } = build();
    const saved = repository.save(anchored('mice', essays, 12, 10, 14, 'the mice scattered'));
    repository.remove(saved.id);

    tick('2027-12-12T00:00:00.000Z');
    repository.restore(saved);

    const [restored] = repository.list({
      sort: 'newest',
      documentId: null,
      cursor: null,
      limit: 10,
    }).items;

    expect(restored?.id).toBe(saved.id);
    expect(restored?.savedAt).toBe(saved.savedAt);
    expect(restored?.snapshot).toEqual(saved.snapshot);
    expect(restored?.occurrences).toEqual(saved.occurrences);
  });
});

describe('listing the library', () => {
  const populate = (built: Built, count: number): void => {
    for (let index = 0; index < count; index += 1) {
      built.tick(`2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`);
      built.repository.save(
        request(
          `word${String(index).padStart(3, '0')}`,
          index % 2 === 0 ? essays : letters,
          index + 1,
        ),
      );
    }
  };

  it('pages by keyset without repeating or skipping a row', () => {
    const built = build();
    populate(built, 120);

    const seen: string[] = [];
    let cursor = null as { sortKey: string; id: string } | null;

    for (let page = 0; page < 4; page += 1) {
      const result = built.repository.list({
        sort: 'alphabetical',
        documentId: null,
        cursor,
        limit: 50,
      });

      seen.push(...result.items.map((item) => item.word.display));
      cursor = result.nextCursor === null ? null : { ...result.nextCursor };

      if (cursor === null) {
        break;
      }
    }

    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    expect(seen).toEqual([...seen].sort((left, right) => left.localeCompare(right)));
    expect(cursor).toBeNull();
  });

  it('caps a page at fifty rows however many are asked for', () => {
    const built = build();
    populate(built, 60);

    expect(
      built.repository.list({ sort: 'newest', documentId: null, cursor: null, limit: 5_000 }).items,
    ).toHaveLength(50);
  });

  it('orders newest, oldest and alphabetical as named', () => {
    const built = build();
    built.tick('2026-01-01T00:00:00.000Z');
    built.repository.save(request('zebra', essays, 1));
    built.tick('2026-02-01T00:00:00.000Z');
    built.repository.save(request('apple', essays, 2));

    const names = (sort: 'newest' | 'oldest' | 'alphabetical'): string[] =>
      built.repository
        .list({ sort, documentId: null, cursor: null, limit: 10 })
        .items.map((item) => item.word.display);

    expect(names('newest')).toEqual(['apple', 'zebra']);
    expect(names('oldest')).toEqual(['zebra', 'apple']);
    expect(names('alphabetical')).toEqual(['apple', 'zebra']);
  });

  it('filters to one document', () => {
    const built = build();
    built.repository.save(request('mice', essays, 1));
    built.repository.save(request('otter', letters, 1));

    const page = built.repository.list({
      sort: 'newest',
      documentId: 'doc-2',
      cursor: null,
      limit: 10,
    });

    expect(page.items.map((item) => item.word.display)).toEqual(['otter']);
  });

  it('offers each document once, with a count of the words saved from it', () => {
    const built = build();
    built.repository.save(request('mice', essays, 1));
    built.repository.save(request('mice', essays, 2));
    built.repository.save(request('otter', letters, 1));

    expect(built.repository.documents()).toEqual([
      { documentId: 'doc-1', name: 'Essays.pdf', available: true, count: 1 },
      { documentId: 'doc-2', name: 'Letters.pdf', available: true, count: 1 },
    ]);
  });
});

describe('searching', () => {
  const seeded = (): Built => {
    const built = build();
    built.repository.save(request('thole', essays, 1, { shortDefinition: 'a pin in a gunwale' }));
    built.repository.save(
      request('thorough', essays, 2, { shortDefinition: 'carried out completely' }),
    );
    built.repository.save(
      request('mice', letters, 3, { shortDefinition: 'small rodents with long tails' }),
    );

    return built;
  };

  it('matches a prefix of the word before anything else', () => {
    const results = seeded().repository.search({ query: 'tho', documentId: null, limit: 200 });

    expect(results.matches.map((item) => item.word.display)).toEqual(['thole', 'thorough']);
    expect(results.definitionMatches).toHaveLength(0);
  });

  it('matches inside a definition only in the second tier', () => {
    const results = seeded().repository.search({ query: 'rodents', documentId: null, limit: 200 });

    expect(results.matches).toHaveLength(0);
    expect(results.definitionMatches.map((item) => item.word.display)).toEqual(['mice']);
  });

  it('never lists a word in both tiers', () => {
    const built = seeded();
    built.repository.save(request('gunwale', essays, 9, { shortDefinition: 'the top of a hull' }));

    const results = built.repository.search({ query: 'gunwale', documentId: null, limit: 200 });

    expect(results.matches.map((item) => item.word.display)).toEqual(['gunwale']);
    expect(results.definitionMatches.map((item) => item.word.display)).toEqual(['thole']);
  });

  it('does not search definitions for a query of two characters', () => {
    const built = seeded();
    built.repository.save(request('pin', essays, 8, { shortDefinition: 'a small fastener' }));

    const results = built.repository.search({ query: 'pi', documentId: null, limit: 200 });

    expect(results.matches.map((item) => item.word.display)).toEqual(['pin']);
    expect(results.definitionMatches).toHaveLength(0);
  });

  it('treats a wildcard as a character, not as a wildcard', () => {
    const built = build();
    built.repository.save(request('mice', essays, 1));

    expect(built.repository.search({ query: '%', documentId: null, limit: 200 }).matches).toEqual(
      built.repository.list({ sort: 'newest', documentId: null, cursor: null, limit: 200 }).items,
    );
    expect(
      built.repository.search({ query: 'm_ce', documentId: null, limit: 200 }).matches,
    ).toHaveLength(0);
  });

  it('lists the library when the query is empty', () => {
    const results = seeded().repository.search({ query: '   ', documentId: null, limit: 200 });

    expect(results.matches).toHaveLength(3);
  });

  it('honours the document filter', () => {
    const results = seeded().repository.search({ query: 'mice', documentId: 'doc-1', limit: 200 });

    expect(results.matches).toHaveLength(0);
  });

  it('stops at two hundred rows and says it stopped', () => {
    const built = build();

    for (let index = 0; index < 205; index += 1) {
      built.repository.save(request(`search${String(index).padStart(3, '0')}`, essays, index + 1));
    }

    const results = built.repository.search({ query: 'search', documentId: null, limit: 5_000 });

    expect(results.matches).toHaveLength(200);
    expect(results.truncated).toBe(true);
  });

  it('matches case and accents through the normalised form', () => {
    const built = build();
    built.repository.save(
      request('Café', essays, 1, {
        word: { raw: 'Café', display: 'Café', normalized: 'café', joinedAcrossLines: false },
      }),
    );

    expect(
      built.repository.search({ query: 'CAFÉ', documentId: null, limit: 200 }).matches,
    ).toHaveLength(1);
  });
});

describe('documents as provenance', () => {
  it('refreshes the name and path when the same content is opened from elsewhere', () => {
    const { repository, database } = build();
    repository.save(request('mice', essays, 1));
    repository.save(
      request('otter', { ...essays, name: 'Essays (copy).pdf', path: '/tmp/Essays.pdf' }, 2),
    );

    expect(
      database.prepare('SELECT name, last_known_path FROM documents WHERE id = ?').get('doc-1'),
    ).toMatchObject({ name: 'Essays (copy).pdf', last_known_path: '/tmp/Essays.pdf' });
  });

  it('keeps documents with the same name but different content apart', () => {
    const { repository } = build();
    repository.save(request('mice', essays, 1));
    repository.save(request('otter', { ...letters, name: 'Essays.pdf' }, 1));

    expect(repository.documents().map((option) => option.documentId)).toEqual(['doc-1', 'doc-2']);
  });

  it('keeps the data when the file is gone, marking it unavailable', () => {
    const { repository } = build();
    repository.save(request('mice', { ...essays, path: null }, 1));

    expect(repository.documents()).toEqual([
      { documentId: 'doc-1', name: 'Essays.pdf', available: false, count: 1 },
    ]);
    expect(
      repository.occurrences(
        repository.list({ sort: 'newest', documentId: null, cursor: null, limit: 10 }).items[0]!.id,
      )[0],
    ).toMatchObject({ documentPath: null, page: 1 });
  });
});

describe('rows that cannot be read', () => {
  it('are counted and skipped, never deleted', () => {
    const { repository, database } = build();
    repository.save(request('mice', essays, 1));
    repository.save(request('otter', essays, 2));

    database.exec(
      "UPDATE vocabulary_items SET lookup_status = 'sorcery' WHERE display_word = 'mice'",
    );

    const page = repository.list({ sort: 'newest', documentId: null, cursor: null, limit: 10 });

    expect(page.items.map((item) => item.word.display)).toEqual(['otter']);
    expect(page.unreadable).toBe(1);
    expect(
      database.prepare('SELECT count(*) AS n FROM vocabulary_items').get() as { n: number },
    ).toEqual({ n: 2 });
  });
});
