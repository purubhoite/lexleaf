/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DictionaryQuery, DictionaryResult } from '@core/dictionary/types';
import type { IdentifiedWord } from '@core/word/types';
import type { DesktopBridge } from '@shared/ipc/contracts';

import { readTextLayer } from '../pdf/textLayerIndex';
import {
  createPageRegistry,
  nextRenderGeneration,
  PAGE_NUMBER_ATTRIBUTE,
  type LivePage,
  type PageRegistry,
} from '../interaction/pageRegistry';
import type { WordInteraction } from '../interaction/resolveInteraction';

import { LOADING_DELAY_MS, useDictionaryLookup } from './useDictionaryLookup';

/**
 * What the hook has to get right is not the happy path — it is everything
 * that happens while the answer is in flight. The reader keeps reading: the
 * page scrolls away, the document closes, another word is double-clicked.
 * An answer that arrives after any of those is wrong, not late (ADR-018).
 */

const identified = (word: string): IdentifiedWord => ({
  raw: word,
  display: word,
  normalized: word.toLowerCase(),
  joinedAcrossLines: false,
  start: 0,
  end: word.length,
});

const found = (headword: string): DictionaryResult => ({
  status: 'found',
  queried: headword,
  headword,
  resolvedBy: 'exact',
  senses: [
    {
      partOfSpeech: 'noun',
      definition: 'A definition.',
      examples: [],
      synonyms: [],
      source: 'wordnet',
    },
  ],
  pronunciations: [],
  alsoInflectionOf: [],
  attribution: {
    datasetName: 'Synthetic test dictionary',
    release: 'fixture-1',
    licences: [{ name: 'Test', url: 'file://AGENTS.md' }],
    modified: true,
    modificationStatement: 'Modified.',
    credits: ['Tests'],
  },
});

const buildPage = (pageNumber: number, documentId = 'doc-1'): LivePage => {
  const container = document.createElement('div');

  container.setAttribute(PAGE_NUMBER_ATTRIBUTE, String(pageNumber));

  const layerElement = document.createElement('div');

  layerElement.className = 'textLayer';

  const span = document.createElement('span');

  span.setAttribute('role', 'presentation');
  span.textContent = 'harbour lighthouse';
  layerElement.append(span);
  container.append(layerElement);
  document.body.append(container);

  return {
    documentId,
    pageNumber,
    generation: nextRenderGeneration(),
    scale: 1,
    container,
    layer: readTextLayer(layerElement),
  };
};

const interactionFor = (page: LivePage, word = 'lighthouse'): WordInteraction => ({
  source: 'pointer',
  documentId: page.documentId,
  pageNumber: page.pageNumber,
  generation: page.generation,
  hit: { kind: 'word', word: identified(word), characterIndex: 0 },
  textIndex: 0,
  milliseconds: 0.1,
});

let registry: PageRegistry;

const bridgeWith = (lookUpWord: DesktopBridge['lookUpWord']): DesktopBridge =>
  ({ lookUpWord }) as unknown as DesktopBridge;

const render = (
  bridge: DesktopBridge | null,
  documentId: string | null = 'doc-1',
): ReturnType<typeof renderHook<ReturnType<typeof useDictionaryLookup>, unknown>> =>
  renderHook(() => useDictionaryLookup({ bridge, registry, documentId }));

beforeEach(() => {
  document.body.innerHTML = '';
  registry = createPageRegistry();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useDictionaryLookup', () => {
  it('starts closed', () => {
    const { result } = render(bridgeWith(() => Promise.resolve(found('book'))));

    expect(result.current.state).toEqual({ status: 'closed', request: null, result: null });
  });

  it('asks the bridge for the normalised word and shows the answer', async () => {
    const page = buildPage(3);

    registry.register(page);

    const queries: DictionaryQuery[] = [];
    const { result } = render(
      bridgeWith((query) => {
        queries.push(query);

        return Promise.resolve(found('lighthouse'));
      }),
    );

    act(() => {
      result.current.open(interactionFor(page));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });

    expect(queries).toEqual([
      { normalized: 'lighthouse', raw: 'lighthouse', joinedAcrossLines: false },
    ]);
    expect(result.current.state.result).toMatchObject({ headword: 'lighthouse' });
    expect(result.current.state.request).toMatchObject({ pageNumber: 3, documentId: 'doc-1' });
  });

  it('ignores an interaction that did not land on a word', () => {
    const page = buildPage(1);

    registry.register(page);

    const lookUpWord = vi.fn(() => Promise.resolve(found('book')));
    const { result } = render(bridgeWith(lookUpWord));

    act(() => {
      result.current.open({
        ...interactionFor(page),
        hit: { kind: 'miss', reason: 'not-a-word' },
      });
    });

    expect(result.current.state.status).toBe('closed');
    expect(lookUpWord).not.toHaveBeenCalled();
  });

  it('waits the 120 ms the product specification names, not merely some delay', () => {
    // The test below advances the clock relative to this constant, so it
    // passes for any value of it: a mutant that halved the threshold
    // survived the 6.5 acceptance audit's campaign (C-4). The number is
    // the requirement, so the number is pinned here.
    expect(LOADING_DELAY_MS).toBe(120);
  });

  it('does not admit to loading until the lookup has actually been slow', () => {
    vi.useFakeTimers();

    const page = buildPage(1);

    registry.register(page);

    const { result } = render(bridgeWith(() => new Promise<DictionaryResult>(() => {})));

    act(() => {
      result.current.open(interactionFor(page));
    });

    expect(result.current.state.status).toBe('pending');

    act(() => {
      vi.advanceTimersByTime(LOADING_DELAY_MS - 1);
    });

    expect(result.current.state.status).toBe('pending');

    act(() => {
      vi.advanceTimersByTime(2);
    });

    expect(result.current.state.status).toBe('loading');
  });

  it('never shows the loading state for a lookup that answers at once', async () => {
    const page = buildPage(1);

    registry.register(page);

    const { result } = render(bridgeWith(() => Promise.resolve(found('lighthouse'))));
    const seen: string[] = [];

    act(() => {
      result.current.open(interactionFor(page));
    });

    seen.push(result.current.state.status);

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });

    seen.push(result.current.state.status);

    expect(seen).toEqual(['pending', 'ready']);
  });

  it('discards an answer for a word the reader has already moved on from', async () => {
    const page = buildPage(1);

    registry.register(page);

    const answers: ((result: DictionaryResult) => void)[] = [];
    const { result } = render(
      bridgeWith(
        () =>
          new Promise<DictionaryResult>((resolve) => {
            answers.push(resolve);
          }),
      ),
    );

    act(() => {
      result.current.open(interactionFor(page, 'harbour'));
    });
    act(() => {
      result.current.open(interactionFor(page, 'lighthouse'));
    });

    act(() => {
      answers[0]?.(found('harbour'));
      answers[1]?.(found('lighthouse'));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });

    expect(result.current.state.result).toMatchObject({ headword: 'lighthouse' });
  });

  it('discards an answer whose page has been re-rendered', async () => {
    const page = buildPage(1);

    registry.register(page);

    let answer: ((result: DictionaryResult) => void) | null = null;
    const { result } = render(
      bridgeWith(
        () =>
          new Promise<DictionaryResult>((resolve) => {
            answer = resolve;
          }),
      ),
    );

    act(() => {
      result.current.open(interactionFor(page));
    });

    // The page is re-rendered: same number, new generation.
    act(() => {
      registry.release(page.pageNumber, page.generation);
      registry.register({ ...page, generation: nextRenderGeneration() });
    });

    act(() => {
      answer?.(found('lighthouse'));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('closed');
    });
  });

  it('discards an answer whose page has been recycled entirely', async () => {
    const page = buildPage(1);

    registry.register(page);

    let answer: ((result: DictionaryResult) => void) | null = null;
    const { result } = render(
      bridgeWith(
        () =>
          new Promise<DictionaryResult>((resolve) => {
            answer = resolve;
          }),
      ),
    );

    act(() => {
      result.current.open(interactionFor(page));
    });
    act(() => {
      registry.release(page.pageNumber, page.generation);
    });
    act(() => {
      answer?.(found('lighthouse'));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('closed');
    });
  });

  it('closes an open popup when its page goes away', async () => {
    const page = buildPage(1);

    registry.register(page);

    const { result } = render(bridgeWith(() => Promise.resolve(found('lighthouse'))));

    act(() => {
      result.current.open(interactionFor(page));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });

    act(() => {
      registry.release(page.pageNumber, page.generation);
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('closed');
    });
  });

  it('discards an answer that belongs to a document that is no longer open', async () => {
    const page = buildPage(1, 'doc-old');

    registry.register(page);

    let answer: ((result: DictionaryResult) => void) | null = null;
    const { result, rerender } = renderHook(
      ({ documentId }: { documentId: string | null }) =>
        useDictionaryLookup({
          bridge: bridgeWith(
            () =>
              new Promise<DictionaryResult>((resolve) => {
                answer = resolve;
              }),
          ),
          registry,
          documentId,
        }),
      { initialProps: { documentId: 'doc-old' } },
    );

    act(() => {
      result.current.open(interactionFor(page));
    });

    rerender({ documentId: 'doc-new' });

    act(() => {
      answer?.(found('lighthouse'));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('closed');
    });
  });

  it('reports the dictionary as unavailable when the bridge rejects', async () => {
    const page = buildPage(1);

    registry.register(page);

    const { result } = render(bridgeWith(() => Promise.reject(new Error('channel gone'))));

    act(() => {
      result.current.open(interactionFor(page));
    });

    await waitFor(() => {
      expect(result.current.state.result).toEqual({ status: 'unavailable', reason: 'unreadable' });
    });
  });

  it('reports the dictionary as unavailable when there is no bridge at all', async () => {
    const page = buildPage(1);

    registry.register(page);

    const { result } = render(null);

    act(() => {
      result.current.open(interactionFor(page));
    });

    await waitFor(() => {
      expect(result.current.state.result).toEqual({ status: 'unavailable', reason: 'unreadable' });
    });
  });

  it('closes on request and forgets the result', async () => {
    const page = buildPage(1);

    registry.register(page);

    const { result } = render(bridgeWith(() => Promise.resolve(found('lighthouse'))));

    act(() => {
      result.current.open(interactionFor(page));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });

    act(() => {
      result.current.close();
    });

    expect(result.current.state).toEqual({ status: 'closed', request: null, result: null });
  });

  it('does not answer a popup the reader closed while it was in flight', async () => {
    const page = buildPage(1);

    registry.register(page);

    let answer: ((result: DictionaryResult) => void) | null = null;
    const { result } = render(
      bridgeWith(
        () =>
          new Promise<DictionaryResult>((resolve) => {
            answer = resolve;
          }),
      ),
    );

    act(() => {
      result.current.open(interactionFor(page));
    });
    act(() => {
      result.current.close();
    });
    act(() => {
      answer?.(found('lighthouse'));
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('closed');
    });
  });

  it('leaves no timer behind when it unmounts', () => {
    vi.useFakeTimers();

    const page = buildPage(1);

    registry.register(page);

    const { result, unmount } = render(bridgeWith(() => new Promise<DictionaryResult>(() => {})));

    act(() => {
      result.current.open(interactionFor(page));
    });

    unmount();

    expect(() => {
      vi.runAllTimers();
    }).not.toThrow();
  });
});
