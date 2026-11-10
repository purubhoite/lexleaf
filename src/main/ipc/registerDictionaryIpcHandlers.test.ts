import { describe, expect, it, vi } from 'vitest';

import type { DictionaryQuery, DictionaryResult } from '@core/dictionary/types';
import { IpcChannel } from '@shared/ipc/channels';

import {
  registerDictionaryIpcHandlers,
  type DictionaryIpcOptions,
} from './registerDictionaryIpcHandlers';
import type { IpcHandlerRegistrar, IpcInvokeListener } from './senderGuard';

interface FakeIpc extends IpcHandlerRegistrar {
  readonly handlers: Map<string, IpcInvokeListener>;
}

const createIpc = (): FakeIpc => {
  const handlers = new Map<string, IpcInvokeListener>();

  return {
    handlers,
    handle(channel, listener): void {
      handlers.set(channel, listener);
    },
  };
};

const trustedSender = { senderFrame: { url: 'file:///app/out/renderer/index.html' } };

const found: DictionaryResult = {
  status: 'found',
  queried: 'book',
  headword: 'book',
  resolvedBy: 'exact',
  pronunciations: [],
  senses: [
    {
      partOfSpeech: 'noun',
      definition: 'A set of printed pages.',
      examples: [],
      synonyms: [],
      source: 'wordnet',
    },
  ],
  alsoInflectionOf: [],
  attribution: {
    datasetName: 'Synthetic test dictionary',
    release: 'fixture-1',
    licences: [{ name: 'Test', url: 'file://AGENTS.md' }],
    modified: true,
    modificationStatement: 'Modified.',
    credits: ['Tests'],
  },
};

const query: DictionaryQuery = { normalized: 'book', raw: 'Book', joinedAcrossLines: false };

const options = (overrides: Partial<DictionaryIpcOptions> = {}): DictionaryIpcOptions => ({
  lookUp: () => found,
  onRejected: () => undefined,
  devServerOrigin: null,
  ...overrides,
});

describe('registerDictionaryIpcHandlers', () => {
  it('registers exactly one channel', () => {
    const ipc = createIpc();

    registerDictionaryIpcHandlers(ipc, options());

    expect([...ipc.handlers.keys()]).toEqual([IpcChannel.LookUpWord]);
  });

  it('answers a well-formed query from a trusted sender', () => {
    const ipc = createIpc();
    const lookUp = vi.fn(() => found);

    registerDictionaryIpcHandlers(ipc, options({ lookUp }));

    expect(ipc.handlers.get(IpcChannel.LookUpWord)?.(trustedSender, query)).toEqual(found);
    expect(lookUp).toHaveBeenCalledWith(query);
  });

  it('refuses a sender that is not part of this application', () => {
    const ipc = createIpc();
    const lookUp = vi.fn(() => found);

    registerDictionaryIpcHandlers(ipc, options({ lookUp }));

    expect(() =>
      ipc.handlers.get(IpcChannel.LookUpWord)?.(
        { senderFrame: { url: 'https://example.invalid/page' } },
        query,
      ),
    ).toThrow(/untrusted sender/u);
    expect(lookUp).not.toHaveBeenCalled();
  });

  it('refuses a sender with no frame at all', () => {
    const ipc = createIpc();

    registerDictionaryIpcHandlers(ipc, options());

    expect(() => ipc.handlers.get(IpcChannel.LookUpWord)?.({ senderFrame: null }, query)).toThrow(
      /untrusted sender/u,
    );
  });

  it.each([
    ['nothing', undefined],
    ['a string', 'book'],
    ['an empty normalised form', { normalized: '', raw: 'book', joinedAcrossLines: false }],
    ['a missing raw form', { normalized: 'book', joinedAcrossLines: false }],
    ['a non-boolean line-break flag', { normalized: 'book', raw: 'book', joinedAcrossLines: 1 }],
    [
      'an absurdly long word',
      { normalized: 'x'.repeat(5000), raw: 'x'.repeat(5000), joinedAcrossLines: false },
    ],
  ])('answers unavailable when the renderer sends %s', (_name, payload) => {
    const ipc = createIpc();
    const lookUp = vi.fn(() => found);
    const onRejected = vi.fn();

    registerDictionaryIpcHandlers(ipc, options({ lookUp, onRejected }));

    expect(ipc.handlers.get(IpcChannel.LookUpWord)?.(trustedSender, payload)).toEqual({
      status: 'unavailable',
      reason: 'unreadable',
    });
    expect(lookUp).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledOnce();
  });

  it('ignores any extra property the renderer tries to smuggle in', () => {
    const ipc = createIpc();
    const lookUp = vi.fn(() => found);

    registerDictionaryIpcHandlers(ipc, options({ lookUp }));

    ipc.handlers.get(IpcChannel.LookUpWord)?.(trustedSender, {
      ...query,
      artifactPath: '/etc/passwd',
      directory: '/etc',
    });

    expect(lookUp).toHaveBeenCalledWith(query);
    expect(lookUp.mock.lastCall).toEqual([query]);
  });

  it('passes an unavailable result through unchanged', () => {
    const ipc = createIpc();

    registerDictionaryIpcHandlers(
      ipc,
      options({ lookUp: () => ({ status: 'unavailable', reason: 'corrupt' }) }),
    );

    expect(ipc.handlers.get(IpcChannel.LookUpWord)?.(trustedSender, query)).toEqual({
      status: 'unavailable',
      reason: 'corrupt',
    });
  });

  it('accepts the development server as a sender when one is configured', () => {
    const ipc = createIpc();

    registerDictionaryIpcHandlers(ipc, options({ devServerOrigin: 'http://localhost:5173' }));

    expect(
      ipc.handlers.get(IpcChannel.LookUpWord)?.(
        { senderFrame: { url: 'http://localhost:5173/index.html' } },
        query,
      ),
    ).toEqual(found);
  });
});
