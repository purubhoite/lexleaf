import { DatabaseSync } from 'node:sqlite';

import { EXPLANATION_CACHE_ENTRIES } from '@core/ai/limits';
import type { AiFailure, ContextExplainer, ContextExplanationRequest } from '@core/ai/types';
import type { DictionaryResult } from '@core/dictionary/types';
import { err, ok, type Result } from '@core/result';
import type { SaveWordRequest, SavedDocumentFacts } from '@core/vocabulary/types';
import { afterEach, describe, expect, it } from 'vitest';

import { createExplanationStore, type ExplanationStore } from '../vocabulary/explanationStore';
import { migrate } from '../vocabulary/schema';
import { createSqliteVocabularyRepository } from '../vocabulary/sqliteVocabularyRepository';

import { CANCELLED_ABORT_REASON, TIMEOUT_ABORT_REASON } from './abort';
import { createExplanationService, type ExplainCommand } from './explanationService';

/**
 * The service, with a fake provider and a real database.
 *
 * No socket is opened and no provider is contacted anywhere in this file;
 * the explainer is a function a test wrote.
 */

const attribution = {
  datasetName: 'Open English WordNet',
  release: '2024',
  licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
  modified: true,
  modificationStatement: 'Transformed.',
  credits: ['Princeton University'],
};

const found: DictionaryResult = {
  status: 'found',
  queried: 'charge',
  headword: 'charge',
  resolvedBy: 'exact',
  senses: [
    {
      partOfSpeech: 'noun',
      definition: 'a quantity of electricity',
      examples: [],
      synonyms: [],
      source: 'wordnet',
    },
    {
      partOfSpeech: 'verb',
      definition: 'ask an amount as a price',
      examples: [],
      synonyms: [],
      source: 'wordnet',
    },
  ],
  pronunciations: [],
  alsoInflectionOf: [],
  attribution,
};

const essays: SavedDocumentFacts = {
  id: 'doc-1',
  name: 'Essays.pdf',
  path: '/books/Essays.pdf',
  pageCount: 300,
  sizeBytes: 2048,
};

const word = {
  raw: 'charge',
  display: 'charge',
  normalized: 'charge',
  joinedAcrossLines: false,
};

const command = (overrides: Partial<ExplainCommand> = {}): ExplainCommand => ({
  requestId: 'r-1',
  word,
  documentId: 'doc-1',
  page: 10,
  lookupStatus: 'found',
  context: 'The capacitor holds a charge for several minutes.',
  contextWordStart: 22,
  ...overrides,
});

interface Explainer extends ContextExplainer {
  readonly calls: ContextExplanationRequest[];
}

const explainerReturning = (
  reply: (
    request: ContextExplanationRequest,
    signal: AbortSignal,
  ) => Promise<Result<{ text: string; senseIndex: number | null; truncated: boolean }, AiFailure>>,
): Explainer => {
  const calls: ContextExplanationRequest[] = [];

  return {
    calls,
    describe: () => ({ provider: 'api.example.com', model: 'model-a', remote: true }),
    explain: (request, signal): ReturnType<ContextExplainer['explain']> => {
      calls.push(request);

      return reply(request, signal);
    },
  };
};

const answering = (text = 'Here it means electrical charge.'): Explainer =>
  explainerReturning(() => Promise.resolve(ok({ text, senseIndex: 0, truncated: false })));

const saveRequest = (page: number): SaveWordRequest => ({
  word,
  headword: 'charge',
  resolvedBy: 'exact',
  lookupStatus: 'found',
  shortDefinition: 'a quantity of electricity',
  snapshot: null,
  source: null,
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

let open: DatabaseSync[] = [];

interface Harness {
  readonly database: DatabaseSync;
  readonly store: ExplanationStore;
  readonly service: ReturnType<typeof createExplanationService>;
  readonly diagnostics: string[];
  readonly save: (page: number) => string;
  setItemId: (itemId: string | null) => void;
}

const build = (
  explainer: Explainer,
  options: {
    configured?: boolean;
    timeoutMs?: number;
    lookUp?: () => DictionaryResult;
    withStore?: boolean;
  } = {},
): Harness => {
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });

  open.push(database);
  migrate(database);

  const repository = createSqliteVocabularyRepository({ database });
  const store = createExplanationStore({ database });
  const diagnostics: string[] = [];
  let itemId: string | null = null;

  const service = createExplanationService({
    explainer,
    configured: options.configured ?? true,
    providerId: 'openai-compatible:0123456789abcdef',
    modelId: 'model-a',
    store: () => ((options.withStore ?? true) ? store : null),
    resolveItemId: () => itemId,
    lookUp: options.lookUp ?? ((): DictionaryResult => found),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    onDiagnostic: (message) => diagnostics.push(message),
  });

  return {
    database,
    store,
    service,
    diagnostics,
    save: (page) => repository.save(saveRequest(page)).id,
    setItemId: (value): void => {
      itemId = value;
    },
  };
};

afterEach(() => {
  for (const database of open) {
    try {
      database.close();
    } catch {
      // Already closed.
    }
  }

  open = [];
});

const rowCount = (database: DatabaseSync): number =>
  (database.prepare('SELECT count(*) AS n FROM vocabulary_explanations').get() as { n: number }).n;

describe('with no provider configured', () => {
  it('reports that the feature is off and never calls anything', async () => {
    const explainer = answering();
    const harness = build(explainer, { configured: false });

    expect(harness.service.status().configured).toBe(false);
    expect(await harness.service.explain(command())).toEqual({
      ok: false,
      error: { kind: 'not-configured' },
    });
    expect(harness.service.stored(command())).toBeNull();
    expect(explainer.calls).toHaveLength(0);
  });
});

describe('generating an explanation', () => {
  it('sends only the allowlisted payload', async () => {
    const explainer = answering();
    const harness = build(explainer);

    await harness.service.explain(command());

    const sent = explainer.calls[0];

    expect(sent?.word).toEqual({ display: 'charge', normalized: 'charge' });
    expect(sent?.context).toBe('The capacitor holds a charge for several minutes.');
    expect(JSON.stringify(sent)).not.toContain('doc-1');
    expect(JSON.stringify(sent)).not.toContain('Essays.pdf');
    expect(JSON.stringify(sent)).not.toContain('/books');
  });

  it('takes the senses from the local dictionary, not from the caller', async () => {
    const explainer = answering();
    const harness = build(explainer);

    await harness.service.explain(command());

    expect(explainer.calls[0]?.senses).toEqual([
      { partOfSpeech: 'noun', definition: 'a quantity of electricity' },
      { partOfSpeech: 'verb', definition: 'ask an amount as a price' },
    ]);
    expect(explainer.calls[0]?.headword).toBe('charge');
  });

  it('can explain a word the dictionary does not have', async () => {
    const explainer = answering();
    const harness = build(explainer, {
      lookUp: (): DictionaryResult => ({ status: 'not-found', queried: 'quux', attempted: [] }),
    });

    const result = await harness.service.explain(command({ lookupStatus: 'not-found' }));

    expect(result.ok).toBe(true);
    expect(explainer.calls[0]?.senses).toEqual([]);
    expect(explainer.calls[0]?.lookupStatus).toBe('not-found');
  });

  it('labels the destination it would send to', async () => {
    const harness = build(answering());
    const result = await harness.service.explain(command());

    expect(result.ok && result.value).toMatchObject({
      provider: 'api.example.com',
      model: 'model-a',
      remote: true,
      status: 'current',
    });
  });
});

describe('asking the same question twice', () => {
  it('answers a saved word from the database without calling the provider', async () => {
    const explainer = answering();
    const harness = build(explainer);

    harness.setItemId(harness.save(10));

    await harness.service.explain(command());
    const again = await harness.service.explain(command({ requestId: 'r-2' }));

    expect(explainer.calls).toHaveLength(1);
    expect(again.ok && again.value.text).toBe('Here it means electrical charge.');
    expect(rowCount(harness.database)).toBe(1);
  });

  it('answers an unsaved word from memory without calling the provider', async () => {
    const explainer = answering();
    const harness = build(explainer);

    await harness.service.explain(command());
    await harness.service.explain(command({ requestId: 'r-2' }));

    expect(explainer.calls).toHaveLength(1);
    expect(rowCount(harness.database)).toBe(0);
  });

  it('asks again when the excerpt changed', async () => {
    const explainer = answering();
    const harness = build(explainer);

    harness.setItemId(harness.save(10));

    await harness.service.explain(command());
    await harness.service.explain(
      command({ requestId: 'r-2', context: 'They charge a fee at the door.', contextWordStart: 5 }),
    );

    expect(explainer.calls).toHaveLength(2);
    expect(rowCount(harness.database)).toBe(2);
  });

  it('asks again when only the word position inside an identical excerpt changed', async () => {
    const explainer = answering();
    const harness = build(explainer);
    const excerpt = 'charge the charge and then charge again';

    harness.setItemId(harness.save(10));

    await harness.service.explain(command({ context: excerpt, contextWordStart: 0 }));
    await harness.service.explain(
      command({ requestId: 'r-2', context: excerpt, contextWordStart: 11 }),
    );

    expect(explainer.calls).toHaveLength(2);
    expect(rowCount(harness.database)).toBe(2);
  });
});

describe('reading what is already known', () => {
  it('returns nothing before anything was generated', () => {
    const harness = build(answering());

    expect(harness.service.stored(command())).toBeNull();
  });

  it('returns the stored answer for the identical question', async () => {
    const harness = build(answering());

    harness.setItemId(harness.save(10));
    await harness.service.explain(command());

    expect(harness.service.stored(command())?.status).toBe('current');
  });

  it('discloses an answer from an earlier version of the passage, labelled', async () => {
    const harness = build(answering('For the older excerpt.'));

    harness.setItemId(harness.save(10));
    await harness.service.explain(command());

    const stale = harness.service.stored(command({ context: 'A different sentence entirely.' }));

    expect(stale).toMatchObject({ status: 'previous-context', text: 'For the older excerpt.' });
  });

  it('does the same for an unsaved word held in memory', async () => {
    const harness = build(answering('Remembered.'));

    await harness.service.explain(command());

    expect(harness.service.stored(command())?.status).toBe('current');
    expect(
      harness.service.stored(command({ context: 'Another sentence on the same page.' }))?.status,
    ).toBe('previous-context');
  });

  it('never calls the provider', async () => {
    const explainer = answering();
    const harness = build(explainer);

    await harness.service.explain(command());
    harness.service.stored(command());
    harness.service.stored(command({ context: 'Something else.' }));

    expect(explainer.calls).toHaveLength(1);
  });
});

describe('failure, timeout and cancellation', () => {
  it('stores nothing when the provider fails', async () => {
    const harness = build(
      explainerReturning(() => Promise.resolve(err({ kind: 'provider-error' as const }))),
    );

    harness.setItemId(harness.save(10));

    expect(await harness.service.explain(command())).toEqual({
      ok: false,
      error: { kind: 'provider-error' },
    });
    expect(rowCount(harness.database)).toBe(0);
    expect(harness.service.stored(command())).toBeNull();
  });

  it('aborts with a timeout reason when the provider is too slow', async () => {
    const explainer = explainerReturning(
      (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve(
              err(
                signal.reason === TIMEOUT_ABORT_REASON
                  ? ({ kind: 'timeout' } as const)
                  : ({ kind: 'cancelled' } as const),
              ),
            );
          });
        }),
    );
    const harness = build(explainer, { timeoutMs: 5 });

    expect(await harness.service.explain(command())).toEqual({
      ok: false,
      error: { kind: 'timeout' },
    });
  });

  it('cancels a request by id', async () => {
    const harness = build(
      explainerReturning(
        (_request, signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              resolve(
                err(
                  signal.reason === CANCELLED_ABORT_REASON
                    ? ({ kind: 'cancelled' } as const)
                    : ({ kind: 'timeout' } as const),
                ),
              );
            });
          }),
      ),
    );

    const pending = harness.service.explain(command({ requestId: 'r-9' }));

    harness.service.cancel('r-9');

    expect(await pending).toEqual({ ok: false, error: { kind: 'cancelled' } });
  });

  it('abandons the previous request when a new one starts', async () => {
    const harness = build(
      explainerReturning(
        (_request, signal) =>
          new Promise((resolve) => {
            if (signal.aborted) {
              resolve(err({ kind: 'cancelled' as const }));

              return;
            }

            signal.addEventListener('abort', () => {
              resolve(err({ kind: 'cancelled' as const }));
            });

            setTimeout(() => {
              resolve(ok({ text: 'Answered.', senseIndex: null, truncated: false }));
            }, 50);
          }),
      ),
    );

    const first = harness.service.explain(command({ requestId: 'first' }));
    const second = harness.service.explain(
      command({ requestId: 'second', context: 'Another sentence.' }),
    );

    expect(await first).toEqual({ ok: false, error: { kind: 'cancelled' } });
    expect((await second).ok).toBe(true);
  });

  it('never repeats the excerpt or the answer in a diagnostic', async () => {
    const harness = build(answering('A secret-sounding answer.'));

    await harness.service.explain(command());

    const log = harness.diagnostics.join(' ');

    expect(log).not.toContain('The capacitor holds a charge');
    expect(log).not.toContain('A secret-sounding answer.');
  });
});

describe('explaining a word that is not saved', () => {
  it('writes nothing to the database', async () => {
    const harness = build(answering());

    await harness.service.explain(command());

    expect(rowCount(harness.database)).toBe(0);
  });

  it('promotes the cached answer when the reader saves the word', async () => {
    const harness = build(answering('Promoted text.'));

    await harness.service.explain(command());

    const itemId = harness.save(10);

    harness.setItemId(itemId);
    harness.service.promote({ itemId, normalized: 'charge', documentId: 'doc-1', page: 10 });

    expect(rowCount(harness.database)).toBe(1);
    expect(harness.store.listForItem(itemId)[0]?.explanation).toBe('Promoted text.');
    expect(harness.service.stored(command())?.status).toBe('current');
  });

  it('promotes nothing when the save was for another page', async () => {
    const harness = build(answering());

    await harness.service.explain(command({ page: 10 }));

    const itemId = harness.save(84);

    harness.service.promote({ itemId, normalized: 'charge', documentId: 'doc-1', page: 84 });

    expect(rowCount(harness.database)).toBe(0);
  });

  it('promotes nothing by itself: it never creates a vocabulary item', async () => {
    const harness = build(answering());

    await harness.service.explain(command());
    harness.service.promote({
      itemId: 'an-item-that-does-not-exist',
      normalized: 'charge',
      documentId: 'doc-1',
      page: 10,
    });

    expect(rowCount(harness.database)).toBe(0);
    expect(
      (
        harness.database.prepare('SELECT count(*) AS n FROM vocabulary_items').get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  it('keeps the cached answer when the row cannot be written', async () => {
    const harness = build(answering('Still visible.'));

    await harness.service.explain(command());
    harness.service.promote({
      itemId: 'an-item-that-does-not-exist',
      normalized: 'charge',
      documentId: 'doc-1',
      page: 10,
    });

    expect(harness.service.stored(command())?.text).toBe('Still visible.');
    expect(harness.diagnostics.join(' ')).toContain('could not be promoted');
  });

  it('keeps the cache bounded and forgets the oldest words first', async () => {
    const harness = build(answering());

    for (let index = 0; index < EXPLANATION_CACHE_ENTRIES + 3; index += 1) {
      await harness.service.explain(
        command({
          requestId: `r-${String(index)}`,
          page: index + 1,
          context: `Sentence number ${String(index)} about charge.`,
        }),
      );
    }

    expect(
      harness.service.stored(command({ page: 1, context: 'Sentence number 0 about charge.' })),
    ).toBeNull();
    expect(
      harness.service.stored(
        command({
          page: EXPLANATION_CACHE_ENTRIES + 3,
          context: `Sentence number ${String(EXPLANATION_CACHE_ENTRIES + 2)} about charge.`,
        }),
      )?.status,
    ).toBe('current');
  });

  it('forgets everything it was holding when it closes', async () => {
    const harness = build(answering());

    await harness.service.explain(command());
    harness.service.close();

    expect(harness.service.stored(command())).toBeNull();
  });
});

describe('when the database is unavailable', () => {
  it('still explains, and simply stores nothing', async () => {
    const explainer = answering();
    const harness = build(explainer, { withStore: false });

    harness.setItemId('item-1');

    const result = await harness.service.explain(command());

    expect(result.ok).toBe(true);
    expect(rowCount(harness.database)).toBe(0);
  });
});
