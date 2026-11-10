/** @vitest-environment jsdom */
import type { DictionaryResult } from '@core/dictionary/types';
import type { SaveWordIpcRequest, VocabularyIpcResult } from '@shared/ipc/vocabularyContracts';
import type { SavedWord, SavedWordState } from '@core/vocabulary/types';
import type { DesktopBridge, VocabularyBridge } from '@shared/ipc/contracts';
import { act, renderHook, waitFor, type RenderHookResult } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DictionaryRequest } from '../dictionary/useDictionaryLookup';
import { createPageRegistry, type LivePage, type PageRegistry } from '../interaction/pageRegistry';

import { useSaveWord, type SaveWordControl } from './useSaveWord';

/**
 * The save control, exercised against a fake bridge.
 *
 * What is being checked here is behaviour a reader would notice: that a
 * lookup alone saves nothing, that a failure leaves the popup usable, and
 * that an answer about a word they have moved on from is ignored.
 */

const DOCUMENT_ID = 'doc-1';

const page = (text: string, pageNumber = 3, generation = 1): LivePage => {
  const container = document.createElement('div');
  const element = document.createElement('span');

  element.textContent = text;
  container.append(element);
  document.body.append(container);

  return {
    documentId: DOCUMENT_ID,
    pageNumber,
    generation,
    scale: 1,
    container,
    layer: {
      segments: [{ text, endsLine: true }],
      segmentOf: new Map([[element, 0]]),
      elements: [element],
    },
  };
};

const PAGE_TEXT = 'The mice scattered across the floor of the lamp room at dusk.';

const request = (overrides: Partial<DictionaryRequest> = {}): DictionaryRequest => ({
  documentId: DOCUMENT_ID,
  pageNumber: 3,
  generation: 1,
  word: {
    raw: 'mice',
    display: 'mice',
    normalized: 'mice',
    joinedAcrossLines: false,
    start: PAGE_TEXT.indexOf('mice'),
    end: PAGE_TEXT.indexOf('mice') + 4,
  },
  ...overrides,
});

const found: DictionaryResult = {
  status: 'found',
  queried: 'mice',
  headword: 'mouse',
  resolvedBy: 'morphology',
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
  attribution: {
    datasetName: 'Open English WordNet',
    release: '2024',
    licences: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }],
    modified: true,
    modificationStatement: 'Transformed.',
    credits: ['Princeton University'],
  },
};

const savedWord: SavedWord = {
  id: 'item-1',
  word: { raw: 'mice', display: 'mice', normalized: 'mice', joinedAcrossLines: false },
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

interface Fake {
  bridge: DesktopBridge;
  readonly saves: SaveWordIpcRequest[];
  readonly removals: string[];
  state: VocabularyIpcResult<SavedWordState>;
  save: VocabularyIpcResult<SavedWord>;
  remove: VocabularyIpcResult<null>;
}

const fakeBridge = (): Fake => {
  const fake: Fake = {
    saves: [],
    removals: [],
    state: { ok: true, value: { state: 'not-saved' } },
    save: { ok: true, value: savedWord },
    remove: { ok: true, value: null },
    bridge: null as unknown as DesktopBridge,
  };

  const vocabulary: VocabularyBridge = {
    stateForWord: () => Promise.resolve(fake.state),
    save: (payload) => {
      fake.saves.push(payload);

      return Promise.resolve(fake.save);
    },
    remove: (itemId) => {
      fake.removals.push(itemId);

      return Promise.resolve(fake.remove);
    },
    restore: () => Promise.resolve({ ok: true, value: null }),
    list: () =>
      Promise.resolve({
        ok: true,
        value: { items: [], documents: [], nextCursor: null, unreadable: 0 },
      }),
    search: () =>
      Promise.resolve({
        ok: true,
        value: {
          matches: [],
          definitionMatches: [],
          documents: [],
          truncated: false,
          unreadable: 0,
        },
      }),
    occurrences: () => Promise.resolve({ ok: true, value: [] }),
  };

  fake.bridge = { vocabulary } as DesktopBridge;

  return fake;
};

interface Harness {
  readonly registry: PageRegistry;
  readonly rendered: RenderHookResult<SaveWordControl, unknown>;
}

const setUp = (
  fake: Fake,
  overrides: {
    readonly request?: DictionaryRequest | null;
    readonly result?: DictionaryResult;
  } = {},
): Harness => {
  const registry = createPageRegistry();
  registry.register(page(PAGE_TEXT));

  return {
    registry,
    rendered: renderHook(() =>
      useSaveWord({
        bridge: fake.bridge,
        registry,
        documentId: DOCUMENT_ID,
        pageCount: 120,
        request: overrides.request === undefined ? request() : overrides.request,
        result: overrides.result ?? found,
      }),
    ),
  };
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('opening the popup', () => {
  it('asks whether the word is already saved, and saves nothing', async () => {
    const fake = fakeBridge();
    const { rendered } = setUp(fake);

    await waitFor(() => {
      expect(rendered.result.current.state).toBe('not-saved');
    });
    expect(fake.saves).toHaveLength(0);
  });

  it('offers to add a place for a word saved somewhere else', async () => {
    const fake = fakeBridge();
    fake.state = {
      ok: true,
      value: { state: 'saved-elsewhere', itemId: 'item-1', otherPlaces: 2 },
    };

    const { rendered } = setUp(fake);

    await waitFor(() => {
      expect(rendered.result.current.state).toBe('saved-elsewhere');
    });
    expect(rendered.result.current.otherPlaces).toBe(2);
  });

  it('shows a word saved from this page as saved', async () => {
    const fake = fakeBridge();
    fake.state = { ok: true, value: { state: 'saved-here', itemId: 'item-1', otherPlaces: 0 } };

    const { rendered } = setUp(fake);

    await waitFor(() => {
      expect(rendered.result.current.state).toBe('saved-here');
    });
  });

  it('offers to save even when the store cannot be reached, and reports on failure', async () => {
    const fake = fakeBridge();
    fake.state = { ok: false, error: { kind: 'unavailable', reason: 'not-writable' } };
    fake.save = { ok: false, error: { kind: 'unavailable', reason: 'not-writable' } };

    const { rendered } = setUp(fake);

    await waitFor(() => {
      expect(rendered.result.current.state).toBe('not-saved');
    });

    act(() => {
      rendered.result.current.onSave();
    });

    await waitFor(() => {
      expect(rendered.result.current.error).toBe(
        'Saved words cannot be stored: the application has nowhere to write them.',
      );
    });
    expect(rendered.result.current.state).toBe('not-saved');
  });
});

describe('saving', () => {
  it('sends the word, the place and the excerpt taken from the live page', async () => {
    const fake = fakeBridge();
    const { rendered } = setUp(fake);

    await waitFor(() => {
      expect(rendered.result.current.state).toBe('not-saved');
    });

    act(() => {
      rendered.result.current.onSave();
    });

    await waitFor(() => {
      expect(fake.saves).toHaveLength(1);
    });

    const sent = fake.saves[0];

    expect(sent?.word.normalized).toBe('mice');
    expect(sent?.documentId).toBe(DOCUMENT_ID);
    expect(sent?.occurrence.page).toBe(3);
    expect(sent?.occurrence.charStart).toBe(PAGE_TEXT.indexOf('mice'));
    expect(sent?.occurrence.context).toBe(PAGE_TEXT);
    expect(sent?.occurrence.context?.length).toBeLessThanOrEqual(240);
    expect(sent?.result).toEqual(found);
  });

  it('persists nothing that came from PDF.js or the DOM', async () => {
    const fake = fakeBridge();
    const { rendered } = setUp(fake);

    await waitFor(() => {
      expect(rendered.result.current.state).toBe('not-saved');
    });

    act(() => {
      rendered.result.current.onSave();
    });

    await waitFor(() => {
      expect(fake.saves).toHaveLength(1);
    });

    // Serialising would throw on a DOM node, and the shape is checked to be
    // characters and numbers only.
    const serialised = JSON.stringify(fake.saves[0]);

    expect(serialised).not.toContain('HTML');
    expect(JSON.parse(serialised)).toEqual(fake.saves[0]);
  });

  it('shows the word as saved afterwards', async () => {
    const fake = fakeBridge();
    fake.save = { ok: true, value: { ...savedWord, occurrenceCount: 3 } };

    const { rendered } = setUp(fake);

    await waitFor(() => {
      expect(rendered.result.current.state).toBe('not-saved');
    });

    act(() => {
      rendered.result.current.onSave();
    });

    await waitFor(() => {
      expect(rendered.result.current.state).toBe('saved-here');
    });
    expect(rendered.result.current.otherPlaces).toBe(2);
  });

  it('saves a word the dictionary had no entry for', async () => {
    const fake = fakeBridge();
    const notFound: DictionaryResult = {
      status: 'not-found',
      queried: 'xyzzy',
      attempted: ['xyzzy'],
    };
    const { rendered } = setUp(fake, { result: notFound });

    await waitFor(() => {
      expect(rendered.result.current.state).toBe('not-saved');
    });

    act(() => {
      rendered.result.current.onSave();
    });

    await waitFor(() => {
      expect(fake.saves).toHaveLength(1);
    });
    expect(fake.saves[0]?.result.status).toBe('not-found');
  });

  it('does nothing when the page it belonged to has been re-rendered', async () => {
    const fake = fakeBridge();
    const { registry, rendered } = setUp(fake);

    await waitFor(() => {
      expect(rendered.result.current.state).toBe('not-saved');
    });

    registry.register(page(PAGE_TEXT, 3, 2));

    act(() => {
      rendered.result.current.onSave();
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fake.saves).toHaveLength(0);
  });
});

describe('removing from the popup', () => {
  it('removes the whole word, not just this place', async () => {
    const fake = fakeBridge();
    fake.state = { ok: true, value: { state: 'saved-here', itemId: 'item-1', otherPlaces: 2 } };

    const { rendered } = setUp(fake);

    await waitFor(() => {
      expect(rendered.result.current.state).toBe('saved-here');
    });

    act(() => {
      rendered.result.current.onRemove();
    });

    await waitFor(() => {
      expect(rendered.result.current.state).toBe('not-saved');
    });
    expect(fake.removals).toEqual(['item-1']);
  });

  it('keeps the word on screen when removal fails', async () => {
    const fake = fakeBridge();
    fake.state = { ok: true, value: { state: 'saved-here', itemId: 'item-1', otherPlaces: 0 } };
    fake.remove = { ok: false, error: { kind: 'write-failed' } };

    const { rendered } = setUp(fake);

    await waitFor(() => {
      expect(rendered.result.current.state).toBe('saved-here');
    });

    act(() => {
      rendered.result.current.onRemove();
    });

    await waitFor(() => {
      expect(rendered.result.current.error).toBe('That word could not be saved.');
    });
    expect(rendered.result.current.state).toBe('saved-here');
  });
});

describe('without a popup', () => {
  it('asks nothing at all', async () => {
    const fake = fakeBridge();
    const stateForWord = vi.spyOn(fake.bridge.vocabulary, 'stateForWord');

    setUp(fake, { request: null });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(stateForWord).not.toHaveBeenCalled();
  });
});
