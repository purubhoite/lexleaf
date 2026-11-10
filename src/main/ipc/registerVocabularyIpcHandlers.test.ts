import { err, ok } from '@core/result';
import type { SaveWordRequest, SavedDocumentFacts, SavedWord } from '@core/vocabulary/types';
import { normalizeWord } from '@core/word/normalizeWord';
import { IpcChannel } from '@shared/ipc/channels';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VocabularyService } from '../vocabulary/vocabularyService';

import { registerVocabularyIpcHandlers } from './registerVocabularyIpcHandlers';
import type { IpcInvokeListener } from './senderGuard';

/** The guard, the parser, the service, the typed reply — in that order. */

const TRUSTED = { senderFrame: { url: 'file:///app/renderer/index.html' } };
const UNTRUSTED = { senderFrame: { url: 'https://example.com/' } };

const essays: SavedDocumentFacts = {
  id: 'doc-1',
  name: 'Essays.pdf',
  path: '/books/Essays.pdf',
  pageCount: 300,
  sizeBytes: 2_048,
};

const item: SavedWord = {
  id: 'item-1',
  word: { raw: 'Mice', display: 'Mice', normalized: 'mice', joinedAcrossLines: false },
  headword: 'mouse',
  resolvedBy: 'morphology',
  lookupStatus: 'found',
  shortDefinition: 'small rodents',
  snapshot: null,
  source: null,
  occurrences: [],
  savedAt: '2026-01-01T00:00:00.000Z',
  occurrenceCount: 1,
};

const found = {
  status: 'found' as const,
  queried: 'mice',
  headword: 'mouse',
  resolvedBy: 'morphology' as const,
  senses: [
    {
      partOfSpeech: 'noun' as const,
      definition: 'small rodents',
      examples: [],
      synonyms: [],
      source: 'wordnet' as const,
    },
  ],
  pronunciations: [],
  alsoInflectionOf: [],
  attribution: {
    datasetName: 'Open English WordNet',
    release: '2024',
    licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
    modified: true,
    modificationStatement: 'Transformed.',
    credits: ['Princeton University'],
  },
};

const saveMessage = {
  word: { raw: 'Mice', display: 'Mice', normalized: 'mice', joinedAcrossLines: false },
  documentId: 'doc-1',
  pageCount: 300,
  occurrence: {
    page: 12,
    charStart: 10,
    charEnd: 14,
    pageOffsetFraction: 0.4,
    context: 'the mice scattered',
    contextWordStart: 4,
  },
  result: found,
};

const service = (overrides: Partial<VocabularyService> = {}): VocabularyService => ({
  stateForWord: () => ok({ state: 'not-saved' }),
  save: () => ok(item),
  remove: () => ok(undefined),
  restore: () => ok(undefined),
  list: () => ok({ items: [], nextCursor: null, unreadable: 0 }),
  search: () => ok({ matches: [], definitionMatches: [], truncated: false, unreadable: 0 }),
  occurrences: () => ok([]),
  documents: () => ok([]),
  close: (): void => {},
  ...overrides,
});

interface Harness {
  readonly handlers: Map<string, IpcInvokeListener>;
  readonly rejections: string[];
}

let harness: Harness;

const register = (
  overrides: Partial<VocabularyService> = {},
  describeDocument: (id: string) => Promise<SavedDocumentFacts | null> = (id) =>
    Promise.resolve(id === 'doc-1' ? essays : null),
  transformVersion: () => string | null = () => '1.0.0',
): void => {
  registerVocabularyIpcHandlers(
    {
      handle: (channel, listener): void => {
        harness.handlers.set(channel, listener);
      },
    },
    {
      service: service(overrides),
      describeDocument,
      transformVersion,
      onRejected: (message): void => {
        harness.rejections.push(message);
      },
      devServerOrigin: null,
    },
  );
};

const invoke = (channel: string, payload: unknown, event = TRUSTED): Promise<unknown> =>
  Promise.resolve(harness.handlers.get(channel)?.(event, payload));

beforeEach(() => {
  harness = { handlers: new Map(), rejections: [] };
});

describe('the channels that exist', () => {
  it('registers exactly the seven vocabulary channels', () => {
    register();

    expect([...harness.handlers.keys()].sort()).toEqual(
      [
        IpcChannel.VocabularyList,
        IpcChannel.VocabularyOccurrences,
        IpcChannel.VocabularyRemove,
        IpcChannel.VocabularyRestore,
        IpcChannel.VocabularySave,
        IpcChannel.VocabularySearch,
        IpcChannel.VocabularyStateForWord,
      ].sort(),
    );
  });

  it('refuses every one of them for a frame that is not this application', () => {
    register();

    for (const channel of harness.handlers.keys()) {
      expect(() => harness.handlers.get(channel)?.(UNTRUSTED, {})).toThrow(/untrusted sender/u);
    }
  });
});

describe('saving', () => {
  it('looks the document up in the main process rather than believing the renderer', async () => {
    const save = vi.fn((request: SaveWordRequest) => ok({ ...item, word: request.word }));
    register({ save });

    await invoke(IpcChannel.VocabularySave, {
      ...saveMessage,
      documentId: 'doc-1',
      name: 'forged.pdf',
      path: '/etc/shadow',
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].document).toEqual(essays);
  });

  it('refuses a document this process has never opened', async () => {
    const save = vi.fn((request: SaveWordRequest) => ok({ ...item, word: request.word }));
    register({ save });

    const reply = await invoke(IpcChannel.VocabularySave, { ...saveMessage, documentId: 'doc-9' });

    expect(reply).toEqual({ ok: false, error: { kind: 'invalid-request' } });
    expect(save).not.toHaveBeenCalled();
    expect(harness.rejections).toHaveLength(1);
  });

  it('recomputes the identity instead of taking the renderer\u2019s word for it', async () => {
    const save = vi.fn((request: SaveWordRequest) => ok({ ...item, word: request.word }));
    register({ save });

    await invoke(IpcChannel.VocabularySave, {
      ...saveMessage,
      word: { raw: 'Mice', display: 'Mice', normalized: 'elephant', joinedAcrossLines: false },
    });

    expect(save.mock.calls[0]?.[0].word.normalized).toBe('mice');
  });

  it('records which build of the dictionary the snapshot came from', async () => {
    const save = vi.fn((request: SaveWordRequest) => ok({ ...item, word: request.word }));
    register({ save }, undefined, () => '2.1.0');

    await invoke(IpcChannel.VocabularySave, saveMessage);

    expect(save.mock.calls[0]?.[0].source?.transformVersion).toBe('2.1.0');
  });

  it('says so honestly when the artifact version cannot be read', async () => {
    const save = vi.fn((request: SaveWordRequest) => ok({ ...item, word: request.word }));
    register({ save }, undefined, () => null);

    await invoke(IpcChannel.VocabularySave, saveMessage);

    expect(save.mock.calls[0]?.[0].source?.transformVersion).toBe('unknown');
  });

  it('refuses to save when the dictionary never answered', async () => {
    const save = vi.fn((request: SaveWordRequest) => ok({ ...item, word: request.word }));
    register({ save });

    const reply = await invoke(IpcChannel.VocabularySave, {
      ...saveMessage,
      result: { status: 'unavailable', reason: 'not-installed' },
    });

    expect(reply).toEqual({ ok: false, error: { kind: 'invalid-request' } });
    expect(save).not.toHaveBeenCalled();
  });

  it('passes a store failure back as it was classified', async () => {
    register({ save: () => err({ kind: 'unavailable', reason: 'not-writable' }) });

    expect(await invoke(IpcChannel.VocabularySave, saveMessage)).toEqual({
      ok: false,
      error: { kind: 'unavailable', reason: 'not-writable' },
    });
  });
});

describe('the other channels', () => {
  it('answers the state of a word', async () => {
    const stateForWord = vi.fn(() => ok({ state: 'not-saved' as const }));
    register({ stateForWord });

    const reply = await invoke(IpcChannel.VocabularyStateForWord, {
      normalized: 'mice',
      documentId: 'doc-1',
      page: 12,
    });

    expect(reply).toEqual({ ok: true, value: { state: 'not-saved' } });
    expect(stateForWord).toHaveBeenCalledWith('mice', 'doc-1', 12);
  });

  it('asks the store about the normalised word, not the one the renderer sent', async () => {
    const stateForWord = vi.fn(() =>
      ok({ state: 'saved-here' as const, itemId: 'i1', otherPlaces: 0 }),
    );
    register({ stateForWord });

    // The forms Milestone 2 folds together: capitals, a typographic
    // apostrophe and surrounding punctuation. A renderer sending any of
    // them must get the answer for the identity the store holds.
    const reply = await invoke(IpcChannel.VocabularyStateForWord, {
      normalized: '“Mice’s”',
      documentId: 'doc-1',
      page: 12,
    });

    expect(stateForWord).toHaveBeenCalledWith(normalizeWord('“Mice’s”'), 'doc-1', 12);
    expect(stateForWord).toHaveBeenCalledWith("mice's", 'doc-1', 12);
    expect(reply).toEqual({
      ok: true,
      value: { state: 'saved-here', itemId: 'i1', otherPlaces: 0 },
    });
  });

  it('does not ask the store about a word that normalises to nothing', async () => {
    const stateForWord = vi.fn(() => ok({ state: 'not-saved' as const }));
    register({ stateForWord });

    const reply = await invoke(IpcChannel.VocabularyStateForWord, {
      normalized: '!!!',
      documentId: 'doc-1',
      page: 12,
    });

    expect(reply).toEqual({ ok: false, error: { kind: 'invalid-request' } });
    expect(stateForWord).not.toHaveBeenCalled();
  });

  it('rejects a malformed request on every channel without reaching the store', async () => {
    const calls: string[] = [];
    register({
      stateForWord: () => {
        calls.push('state');

        return ok({ state: 'not-saved' });
      },
      remove: () => {
        calls.push('remove');

        return ok(undefined);
      },
      list: () => {
        calls.push('list');

        return ok({ items: [], nextCursor: null, unreadable: 0 });
      },
      search: () => {
        calls.push('search');

        return ok({ matches: [], definitionMatches: [], truncated: false, unreadable: 0 });
      },
      occurrences: () => {
        calls.push('occurrences');

        return ok([]);
      },
    });

    expect(await invoke(IpcChannel.VocabularyStateForWord, { normalized: '' })).toEqual({
      ok: false,
      error: { kind: 'invalid-request' },
    });
    expect(await invoke(IpcChannel.VocabularyRemove, {})).toEqual({
      ok: false,
      error: { kind: 'invalid-request' },
    });
    expect(await invoke(IpcChannel.VocabularyList, { sort: 'DROP TABLE' })).toEqual({
      ok: false,
      error: { kind: 'invalid-request' },
    });
    expect(await invoke(IpcChannel.VocabularySearch, { query: 'x'.repeat(200) })).toEqual({
      ok: false,
      error: { kind: 'invalid-request' },
    });
    expect(await invoke(IpcChannel.VocabularyOccurrences, { itemId: '' })).toEqual({
      ok: false,
      error: { kind: 'invalid-request' },
    });
    expect(calls).toEqual([]);
    expect(harness.rejections).toHaveLength(5);
  });

  it('sends the document filter with every library page', async () => {
    register({
      documents: () => ok([{ documentId: 'doc-1', name: 'Essays.pdf', available: true, count: 4 }]),
    });

    const reply = await invoke(IpcChannel.VocabularyList, {
      sort: 'newest',
      documentId: null,
      cursor: null,
      limit: 50,
    });

    expect(reply).toMatchObject({ ok: true, value: { documents: [{ count: 4 }] } });
  });

  it('removes and restores by id', async () => {
    const remove = vi.fn(() => ok(undefined));
    const restore = vi.fn(() => ok(undefined));
    register({ remove, restore });

    expect(await invoke(IpcChannel.VocabularyRemove, { itemId: 'item-1' })).toEqual({
      ok: true,
      value: null,
    });
    expect(await invoke(IpcChannel.VocabularyRestore, { itemId: 'item-1' })).toEqual({
      ok: true,
      value: null,
    });
    expect(remove).toHaveBeenCalledWith('item-1');
    expect(restore).toHaveBeenCalledWith('item-1');
  });

  it('reports nothing to undo as not-found', async () => {
    register({ restore: () => err({ kind: 'not-found' }) });

    expect(await invoke(IpcChannel.VocabularyRestore, { itemId: 'item-1' })).toEqual({
      ok: false,
      error: { kind: 'not-found' },
    });
  });
});
