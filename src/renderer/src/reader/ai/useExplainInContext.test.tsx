/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DictionaryResult } from '@core/dictionary/types';
import type {
  AiStatusReply,
  ExplainIpcRequest,
  ExplanationIpcView,
  StoredExplanationIpcQuery,
} from '@shared/ipc/aiContracts';
import type { AiBridge, DesktopBridge } from '@shared/ipc/contracts';

import type { DictionaryRequest } from '../dictionary/useDictionaryLookup';
import {
  createPageRegistry,
  nextRenderGeneration,
  PAGE_NUMBER_ATTRIBUTE,
  type LivePage,
  type PageRegistry,
} from '../interaction/pageRegistry';
import { readTextLayer } from '../pdf/textLayerIndex';

import { EXPLANATION_FAILURE_MESSAGE, useExplainInContext } from './useExplainInContext';

/**
 * What matters here is not the happy path.
 *
 * It is that nothing leaves until the reader presses the button, that the
 * passage sent is the one on the page at that moment, and that an answer
 * which no longer describes what is on screen is discarded rather than
 * shown.
 */

const PAGE_TEXT = 'The capacitor holds a charge for several minutes before it fades.';

const buildPage = (pageNumber: number, documentId = 'doc-1', text = PAGE_TEXT): LivePage => {
  const container = document.createElement('div');

  container.setAttribute(PAGE_NUMBER_ATTRIBUTE, String(pageNumber));

  const layerElement = document.createElement('div');

  layerElement.className = 'textLayer';

  const span = document.createElement('span');

  span.setAttribute('role', 'presentation');
  span.textContent = text;
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

const requestFor = (page: LivePage, word = 'charge'): DictionaryRequest => ({
  documentId: page.documentId,
  pageNumber: page.pageNumber,
  generation: page.generation,
  word: {
    raw: word,
    display: word,
    normalized: word,
    joinedAcrossLines: false,
    start: PAGE_TEXT.indexOf(word),
    end: PAGE_TEXT.indexOf(word) + word.length,
  },
});

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
};

const explanation: ExplanationIpcView = {
  text: 'Here it means stored electricity.',
  senseIndex: 0,
  truncated: false,
  createdAt: '2026-02-01T10:00:00.000Z',
  provider: 'api.example.com',
  model: 'model-a',
  remote: true,
  status: 'current',
};

const configured: AiStatusReply = {
  configured: true,
  provider: 'api.example.com',
  model: 'model-a',
  remote: true,
};

interface Spy {
  readonly ai: AiBridge;
  readonly explains: ExplainIpcRequest[];
  readonly reads: StoredExplanationIpcQuery[];
  readonly cancels: string[];
}

const aiBridge = (
  overrides: {
    readonly explain?: AiBridge['explain'];
    readonly storedExplanation?: AiBridge['storedExplanation'];
  } = {},
  status = configured,
): Spy => {
  const explains: ExplainIpcRequest[] = [];
  const reads: StoredExplanationIpcQuery[] = [];
  const cancels: string[] = [];
  const reply =
    overrides.explain ??
    ((): ReturnType<AiBridge['explain']> => Promise.resolve({ ok: true, value: explanation }));

  return {
    explains,
    reads,
    cancels,
    ai: {
      status: () => Promise.resolve(status),
      storedExplanation: (query): ReturnType<AiBridge['storedExplanation']> => {
        reads.push(query);

        return overrides.storedExplanation?.(query) ?? Promise.resolve(null);
      },
      // Recorded first, always: a test that replaces the answer still
      // observes exactly what would have been sent.
      explain: (request): ReturnType<AiBridge['explain']> => {
        explains.push(request);

        return reply(request);
      },
      cancel: (requestId): Promise<void> => {
        cancels.push(requestId);

        return Promise.resolve();
      },
    },
  };
};

let registry: PageRegistry;

const render = (
  ai: AiBridge | null,
  request: DictionaryRequest | null,
  result: DictionaryResult | null = found,
): ReturnType<typeof renderHook<ReturnType<typeof useExplainInContext>, unknown>> =>
  renderHook(() =>
    useExplainInContext({
      bridge: ai === null ? null : ({ ai } as unknown as DesktopBridge),
      registry,
      documentId: 'doc-1',
      request,
      result,
    }),
  );

beforeEach(() => {
  document.body.innerHTML = '';
  registry = createPageRegistry();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('when no provider is configured', () => {
  it('reports unsupported and never asks for anything', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge({}, { configured: false, provider: 'none', model: 'none', remote: false });
    const { result } = render(spy.ai, requestFor(page));

    await waitFor(() => {
      expect(result.current.state).toBe('unsupported');
    });

    act(() => {
      result.current.onExplain();
    });

    expect(spy.explains).toHaveLength(0);
    expect(spy.reads).toHaveLength(0);
    expect(result.current.destination).toBeNull();
  });

  it('reports unsupported with no bridge at all', () => {
    const page = buildPage(4);

    registry.register(page);

    const { result } = render(null, requestFor(page));

    expect(result.current.state).toBe('unsupported');
  });
});

describe('opening the popup', () => {
  it('reads what is stored and sends nothing', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge();
    const { result } = render(spy.ai, requestFor(page));

    await waitFor(() => {
      expect(spy.reads).toHaveLength(1);
    });

    expect(spy.explains).toHaveLength(0);
    expect(result.current.state).toBe('idle');
    expect(result.current.destination).toEqual(configured);
  });

  it('shows a stored explanation without generating one', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge({ storedExplanation: () => Promise.resolve(explanation) });
    const { result } = render(spy.ai, requestFor(page));

    await waitFor(() => {
      expect(result.current.state).toBe('ready');
    });

    expect(result.current.explanation?.text).toBe('Here it means stored electricity.');
    expect(spy.explains).toHaveLength(0);
  });

  it('labels an explanation written for an earlier version of the passage', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge({
      storedExplanation: () => Promise.resolve({ ...explanation, status: 'previous-context' }),
    });
    const { result } = render(spy.ai, requestFor(page));

    await waitFor(() => {
      expect(result.current.state).toBe('stale');
    });
  });
});

describe('pressing the button', () => {
  it('sends the passage as it is on the page right now', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge();
    const { result } = render(spy.ai, requestFor(page));

    await waitFor(() => {
      expect(result.current.state).toBe('idle');
    });

    act(() => {
      result.current.onExplain();
    });

    await waitFor(() => {
      expect(spy.explains).toHaveLength(1);
    });

    const sent = spy.explains[0];

    expect(sent?.context).toContain('charge');
    expect(sent?.context.length).toBeLessThanOrEqual(240);
    expect(sent?.word.normalized).toBe('charge');
    expect(sent?.page).toBe(4);
    expect(sent?.lookupStatus).toBe('found');
  });

  it('shows the answer', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge();
    const { result } = render(spy.ai, requestFor(page));

    await waitFor(() => {
      expect(result.current.state).toBe('idle');
    });

    act(() => {
      result.current.onExplain();
    });

    await waitFor(() => {
      expect(result.current.state).toBe('ready');
    });

    expect(result.current.explanation).toEqual(explanation);
  });

  it('does not admit to being slow before the delay', async () => {
    vi.useFakeTimers();

    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge({ explain: () => new Promise(() => {}) });
    const { result } = render(spy.ai, requestFor(page));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.onExplain();
    });

    expect(result.current.state).toBe('pending');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(result.current.state).toBe('loading');
  });

  it('says one thing when it fails, and offers to try again', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge({
      explain: () => Promise.resolve({ ok: false, error: { kind: 'timeout' } }),
    });
    const { result } = render(spy.ai, requestFor(page));

    await waitFor(() => {
      expect(result.current.state).toBe('idle');
    });

    act(() => {
      result.current.onExplain();
    });

    await waitFor(() => {
      expect(result.current.state).toBe('failed');
    });

    expect(result.current.message).toBe(EXPLANATION_FAILURE_MESSAGE);
    expect(result.current.message).not.toMatch(/http|timeout|429|provider/u);
  });

  it.each([
    ['offline', { kind: 'offline' as const }],
    ['a provider error', { kind: 'provider-error' as const }],
    ['a rejection', { kind: 'rejected' as const, reason: 'auth' as const }],
    ['an unusable reply', { kind: 'unusable-response' as const, reason: 'malformed' as const }],
  ])('says the same single sentence for %s', async (_name, error) => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge({ explain: () => Promise.resolve({ ok: false, error }) });
    const { result } = render(spy.ai, requestFor(page));

    await waitFor(() => {
      expect(result.current.state).toBe('idle');
    });

    act(() => {
      result.current.onExplain();
    });

    await waitFor(() => {
      expect(result.current.message).toBe(EXPLANATION_FAILURE_MESSAGE);
    });
  });

  it('says nothing at all when the reader cancelled', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge({
      explain: () => Promise.resolve({ ok: false, error: { kind: 'cancelled' } }),
    });
    const { result } = render(spy.ai, requestFor(page));

    await waitFor(() => {
      expect(result.current.state).toBe('idle');
    });

    act(() => {
      result.current.onExplain();
    });

    await waitFor(() => {
      expect(result.current.state).toBe('idle');
    });

    expect(result.current.message).toBeNull();
  });

  it('becomes unsupported if the provider disappeared since the popup opened', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge({
      explain: () => Promise.resolve({ ok: false, error: { kind: 'not-configured' } }),
    });
    const { result } = render(spy.ai, requestFor(page));

    await waitFor(() => {
      expect(result.current.state).toBe('idle');
    });

    act(() => {
      result.current.onExplain();
    });

    await waitFor(() => {
      expect(result.current.state).toBe('unsupported');
    });
  });

  it('sends nothing when the dictionary itself was unavailable', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge();
    const { result } = render(spy.ai, requestFor(page), {
      status: 'unavailable',
      reason: 'not-installed',
    });

    await waitFor(() => {
      expect(result.current.state).toBe('idle');
    });

    act(() => {
      result.current.onExplain();
    });

    expect(spy.explains).toHaveLength(0);
  });
});

describe('cancelling', () => {
  it('abandons the request by its id and says nothing', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge({ explain: () => new Promise(() => {}) });
    const { result } = render(spy.ai, requestFor(page));

    await waitFor(() => {
      expect(result.current.state).toBe('idle');
    });

    act(() => {
      result.current.onExplain();
    });

    await waitFor(() => {
      expect(spy.explains).toHaveLength(1);
    });

    act(() => {
      result.current.onCancel();
    });

    expect(spy.cancels).toEqual([spy.explains[0]?.requestId]);
    expect(result.current.state).toBe('idle');
    expect(result.current.message).toBeNull();
  });
});

describe('answers that no longer describe the screen', () => {
  it('discards a reply for a word the reader has moved on from', async () => {
    const page = buildPage(4);

    registry.register(page);

    let settle: ((view: { ok: true; value: ExplanationIpcView }) => void) | null = null;

    const spy = aiBridge({
      explain: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    });

    const first = requestFor(page, 'charge');
    const { result, rerender } = renderHook(
      ({ request }: { request: DictionaryRequest }) =>
        useExplainInContext({
          bridge: { ai: spy.ai } as unknown as DesktopBridge,
          registry,
          documentId: 'doc-1',
          request,
          result: found,
        }),
      { initialProps: { request: first } },
    );

    await waitFor(() => {
      expect(result.current.state).toBe('idle');
    });

    act(() => {
      result.current.onExplain();
    });

    await waitFor(() => {
      expect(spy.explains).toHaveLength(1);
    });

    rerender({ request: requestFor(page, 'capacitor') });

    await act(async () => {
      settle?.({ ok: true, value: explanation });
      await Promise.resolve();
    });

    expect(result.current.state).toBe('idle');
    expect(result.current.explanation).toBeNull();
  });

  it('refuses to send when the page it was asked about has been recycled', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge();
    const { result } = render(spy.ai, requestFor(page));

    await waitFor(() => {
      expect(result.current.state).toBe('idle');
    });

    // Inside `act`, because a recycle is a real event the hook now
    // subscribes to: the render it causes must be flushed before the press,
    // exactly as it would be in the application.
    act(() => {
      registry.release(page.pageNumber, page.generation);
    });

    act(() => {
      result.current.onExplain();
    });

    expect(spy.explains).toHaveLength(0);
    expect(result.current.state).toBe('failed');
  });
});

/**
 * Investigation section 11.3 and renderer test 34.
 *
 * Raising the token stops a late answer being *shown*. It does not stop the
 * work: without `ai:cancel` the main process keeps a provider request open
 * for up to twenty seconds after the reader has moved on. Each case below
 * is one of the four ways a question can stop being the question on screen.
 */
describe('abandoning a request that is still in flight', () => {
  const lifecycle = (
    spy: Spy,
    request: DictionaryRequest | null,
    documentId: string | null = 'doc-1',
  ): ReturnType<
    typeof renderHook<
      ReturnType<typeof useExplainInContext>,
      { request: DictionaryRequest | null; documentId: string | null }
    >
  > =>
    renderHook(
      ({
        request: current,
        documentId: currentDocument,
      }: {
        request: DictionaryRequest | null;
        documentId: string | null;
      }) =>
        useExplainInContext({
          bridge: { ai: spy.ai } as unknown as DesktopBridge,
          registry,
          documentId: currentDocument,
          request: current,
          result: found,
        }),
      { initialProps: { request, documentId } },
    );

  /** Starts a request that never answers, and reports the id it was given. */
  const startExplaining = async (
    spy: Spy,
    hook: ReturnType<typeof lifecycle>,
  ): Promise<string | undefined> => {
    await waitFor(() => {
      expect(hook.result.current.state).toBe('idle');
    });

    act(() => {
      hook.result.current.onExplain();
    });

    await waitFor(() => {
      expect(spy.explains).toHaveLength(1);
    });

    return spy.explains[0]?.requestId;
  };

  it('cancels with the original id when the reader selects another word', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge({ explain: () => new Promise(() => {}) });
    const hook = lifecycle(spy, requestFor(page, 'charge'));
    const requestId = await startExplaining(spy, hook);

    act(() => {
      hook.rerender({ request: requestFor(page, 'capacitor'), documentId: 'doc-1' });
    });

    await waitFor(() => {
      expect(spy.cancels).toEqual([requestId]);
    });
    expect(requestId).toBeTypeOf('string');
  });

  it('cancels with the original id when the popup closes', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge({ explain: () => new Promise(() => {}) });
    const hook = lifecycle(spy, requestFor(page));
    const requestId = await startExplaining(spy, hook);

    act(() => {
      hook.rerender({ request: null, documentId: 'doc-1' });
    });

    await waitFor(() => {
      expect(spy.cancels).toEqual([requestId]);
    });
  });

  it('cancels with the original id when the reader leaves the view entirely', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge({ explain: () => new Promise(() => {}) });
    const hook = lifecycle(spy, requestFor(page));
    const requestId = await startExplaining(spy, hook);

    act(() => {
      hook.unmount();
    });

    await waitFor(() => {
      expect(spy.cancels).toEqual([requestId]);
    });
  });

  it('cancels with the original id when the page it was asked about is recycled', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge({ explain: () => new Promise(() => {}) });
    const hook = lifecycle(spy, requestFor(page));
    const requestId = await startExplaining(spy, hook);

    act(() => {
      registry.release(page.pageNumber, page.generation);
    });

    await waitFor(() => {
      expect(spy.cancels).toEqual([requestId]);
    });
  });

  it('cancels with the original id when the document changes', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge({ explain: () => new Promise(() => {}) });
    const hook = lifecycle(spy, requestFor(page));
    const requestId = await startExplaining(spy, hook);

    act(() => {
      hook.rerender({ request: requestFor(page), documentId: 'doc-2' });
    });

    await waitFor(() => {
      expect(spy.cancels).toEqual([requestId]);
    });
  });

  it('cancels nothing once the answer has arrived', async () => {
    const page = buildPage(4);

    registry.register(page);

    const spy = aiBridge();
    const hook = lifecycle(spy, requestFor(page, 'charge'));

    await waitFor(() => {
      expect(hook.result.current.state).toBe('idle');
    });

    act(() => {
      hook.result.current.onExplain();
    });

    await waitFor(() => {
      expect(hook.result.current.state).toBe('ready');
    });

    act(() => {
      hook.rerender({ request: requestFor(page, 'capacitor'), documentId: 'doc-1' });
    });
    act(() => {
      hook.unmount();
    });

    expect(spy.cancels).toEqual([]);
  });

  it('still discards a late answer it has already cancelled', async () => {
    const page = buildPage(4);

    registry.register(page);

    let settle: ((view: { ok: true; value: ExplanationIpcView }) => void) | null = null;

    const spy = aiBridge({
      explain: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    });
    const hook = lifecycle(spy, requestFor(page, 'charge'));

    await startExplaining(spy, hook);

    act(() => {
      hook.rerender({ request: requestFor(page, 'capacitor'), documentId: 'doc-1' });
    });

    await act(async () => {
      settle?.({ ok: true, value: explanation });
      await Promise.resolve();
    });

    expect(hook.result.current.state).toBe('idle');
    expect(hook.result.current.explanation).toBeNull();
  });
});
