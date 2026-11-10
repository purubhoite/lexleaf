/**
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readTextLayer } from '../pdf/textLayerIndex';

import {
  createPageRegistry,
  nextRenderGeneration,
  PAGE_NUMBER_ATTRIBUTE,
  type LivePage,
  type PageRegistry,
} from './pageRegistry';
import { useWordInteraction, type WordInteractionControls } from './useWordInteraction';

/**
 * The hook's job on top of `resolveInteraction`: never show a word from a
 * page that has been recycled, never carry a word across a document change,
 * and let the keyboard walk from one page onto the next as pages render.
 */

const buildPage = (
  pageNumber: number,
  runs: readonly string[],
  documentId = 'doc-1',
): { readonly live: LivePage; readonly spans: readonly HTMLElement[] } => {
  const container = document.createElement('div');

  container.setAttribute(PAGE_NUMBER_ATTRIBUTE, String(pageNumber));

  const layerElement = document.createElement('div');

  layerElement.className = 'textLayer';

  const spans = runs.map((text) => {
    const span = document.createElement('span');

    span.setAttribute('role', 'presentation');
    span.textContent = text;
    layerElement.append(span);

    return span;
  });

  container.append(layerElement);
  document.body.append(container);

  return {
    spans,
    live: {
      documentId,
      pageNumber,
      generation: nextRenderGeneration(),
      scale: 1,
      container,
      layer: readTextLayer(layerElement),
    },
  };
};

const word = (controls: WordInteractionControls): string | null => {
  const hit = controls.interaction?.hit;

  return hit !== undefined && hit.kind === 'word' ? hit.word.display : null;
};

let registry: PageRegistry;
let revealed: number[];
// eslint-disable-next-line @typescript-eslint/unbound-method -- restored verbatim below.
const originalRect = Range.prototype.getBoundingClientRect;

/**
 * jsdom implements neither of the two browser services the pointer route
 * needs, so they are supplied here; `pointAt` is simply "the reader clicked
 * this character of this run".
 */
const pointAt = (element: Element | null, offset: number): void => {
  const browser = document as unknown as {
    elementFromPoint: () => Element | null;
    caretPositionFromPoint: () => { offsetNode: Node; offset: number } | null;
  };

  browser.elementFromPoint = (): Element | null => element;
  browser.caretPositionFromPoint = (): { offsetNode: Node; offset: number } | null => {
    const node = element?.firstChild ?? null;

    return node === null ? null : { offsetNode: node, offset };
  };
};

beforeEach(() => {
  document.body.innerHTML = '';
  registry = createPageRegistry();
  revealed = [];
  Range.prototype.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 1_000, 1_000);
});

afterEach(() => {
  Range.prototype.getBoundingClientRect = originalRect;
  vi.restoreAllMocks();
});

const render = (
  documentId: string | null = 'doc-1',
  currentPage = 1,
  pageCount = 5,
): ReturnType<typeof renderHook<WordInteractionControls, unknown>> =>
  renderHook(() =>
    useWordInteraction({
      registry,
      documentId,
      currentPage,
      pageCount,
      revealPage: (pageNumber: number) => {
        revealed.push(pageNumber);
      },
    }),
  );

describe('useWordInteraction', () => {
  it('has nothing to show before the reader has done anything', () => {
    const { result } = render();

    expect(result.current.interaction).toBeNull();
    expect(result.current.interacted).toBe(false);
    expect(result.current.cursor).toBeNull();
  });

  it('resolves a click against the page it landed on', () => {
    const six = buildPage(6, ['harbour lighthouse']);
    const seven = buildPage(7, ['anchorage jetty']);

    registry.register(six.live);
    registry.register(seven.live);

    const { result } = render();

    act(() => {
      pointAt(seven.spans[0] ?? null, 2);
      result.current.handlePointerDown({ clientX: 5, clientY: 5 });
    });

    expect(result.current.interacted).toBe(true);
    expect(result.current.interaction?.pageNumber).toBe(7);
    expect(word(result.current)).toBe('anchorage');
  });

  it('forgets the word when its page is recycled', () => {
    const page = buildPage(3, ['harbour']);

    registry.register(page.live);

    const { result } = render();

    act(() => {
      pointAt(page.spans[0] ?? null, 1);
      result.current.handlePointerDown({ clientX: 5, clientY: 5 });
    });
    expect(word(result.current)).toBe('harbour');

    act(() => {
      registry.release(3, page.live.generation);
    });

    expect(result.current.interaction).toBeNull();
    // The reader did interact, so the panel can still explain itself.
    expect(result.current.interacted).toBe(true);
  });

  it('forgets the word when its page is rendered again', () => {
    const first = buildPage(3, ['harbour']);

    registry.register(first.live);

    const { result } = render();

    act(() => {
      pointAt(first.spans[0] ?? null, 1);
      result.current.handlePointerDown({ clientX: 5, clientY: 5 });
    });

    act(() => {
      registry.register(buildPage(3, ['harbour']).live);
    });

    expect(result.current.interaction).toBeNull();
  });

  it('forgets everything when the document changes', () => {
    const page = buildPage(3, ['harbour']);

    registry.register(page.live);

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) =>
        useWordInteraction({
          registry,
          documentId: id,
          currentPage: 1,
          pageCount: 5,
          revealPage: () => undefined,
        }),
      { initialProps: { id: 'doc-1' } },
    );

    act(() => {
      pointAt(page.spans[0] ?? null, 1);
      result.current.handlePointerDown({ clientX: 5, clientY: 5 });
    });
    expect(result.current.interaction).not.toBeNull();

    rerender({ id: 'doc-2' });

    expect(result.current.interaction).toBeNull();
    expect(result.current.interacted).toBe(false);
    expect(result.current.cursor).toBeNull();
  });

  it('clears on request', () => {
    const page = buildPage(1, ['harbour']);

    registry.register(page.live);

    const { result } = render();

    act(() => {
      pointAt(page.spans[0] ?? null, 1);
      result.current.handlePointerDown({ clientX: 5, clientY: 5 });
    });

    act(() => {
      result.current.clear();
    });

    expect(result.current.interaction).toBeNull();
    expect(result.current.interacted).toBe(false);
  });

  it('enters the current page from the top with the keyboard', () => {
    registry.register(buildPage(1, ['harbour lighthouse keeper']).live);

    const { result } = render('doc-1', 1);

    act(() => {
      result.current.moveCursor('forward');
    });

    expect(word(result.current)).toBe('harbour');
    expect(result.current.cursor).toEqual({ pageNumber: 1, index: 0 });
    expect(result.current.interaction?.source).toBe('keyboard');
  });

  it('walks word by word, and the keyboard answer matches the pointer answer', () => {
    const page = buildPage(1, ['harbour lighthouse keeper']);

    registry.register(page.live);

    const { result } = render('doc-1', 1);

    act(() => {
      result.current.moveCursor('forward');
    });
    act(() => {
      result.current.moveCursor('forward');
    });

    expect(word(result.current)).toBe('lighthouse');

    act(() => {
      result.current.moveCursor('backward');
    });

    expect(word(result.current)).toBe('harbour');
  });

  it('crosses onto the next page, revealing it and resuming once it renders', () => {
    registry.register(buildPage(1, ['solo']).live);

    const { result } = render('doc-1', 1, 3);

    act(() => {
      result.current.moveCursor('forward');
    });
    expect(word(result.current)).toBe('solo');

    act(() => {
      result.current.moveCursor('forward');
    });

    // The next page is not live yet: nothing is guessed, the page is asked for.
    expect(revealed).toEqual([2]);
    expect(result.current.interaction?.pageNumber).toBe(1);

    act(() => {
      registry.register(buildPage(2, ['second page here']).live);
    });

    expect(result.current.cursor?.pageNumber).toBe(2);
    expect(word(result.current)).toBe('second');
  });

  it('enters a page from its end when walking backwards onto it', () => {
    registry.register(buildPage(2, ['alpha']).live);

    const { result } = render('doc-1', 2, 3);

    act(() => {
      result.current.moveCursor('backward');
    });
    act(() => {
      result.current.moveCursor('backward');
    });

    expect(revealed).toEqual([1]);

    act(() => {
      registry.register(buildPage(1, ['first second third']).live);
    });

    expect(word(result.current)).toBe('third');
  });

  it('skips a page that has no text at all', () => {
    registry.register(buildPage(1, ['only']).live);

    const { result } = render('doc-1', 1, 3);

    act(() => {
      result.current.moveCursor('forward');
    });
    act(() => {
      result.current.moveCursor('forward');
    });

    act(() => {
      registry.register(buildPage(2, ['   ']).live);
    });

    expect(revealed).toEqual([2, 3]);

    act(() => {
      registry.register(buildPage(3, ['third page']).live);
    });

    expect(word(result.current)).toBe('third');
    expect(result.current.cursor?.pageNumber).toBe(3);
  });

  it('stops at the end of the document instead of wrapping', () => {
    registry.register(buildPage(2, ['last']).live);

    const { result } = render('doc-1', 2, 2);

    act(() => {
      result.current.moveCursor('forward');
    });
    act(() => {
      result.current.moveCursor('forward');
    });

    expect(revealed).toEqual([]);
    expect(word(result.current)).toBe('last');
  });

  it('asks for the page the cursor would start on when it is not rendered', () => {
    const { result } = render('doc-1', 4, 10);

    act(() => {
      result.current.moveCursor('forward');
    });

    expect(revealed).toEqual([4]);
    expect(result.current.interaction).toBeNull();

    act(() => {
      registry.register(buildPage(4, ['page four text']).live);
    });

    expect(word(result.current)).toBe('page');
  });

  it('ignores a collapsed selection', () => {
    const page = buildPage(1, ['harbour lighthouse']);

    registry.register(page.live);

    const { result } = render();

    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: true,
      anchorNode: page.spans[0]?.firstChild ?? null,
      anchorOffset: 1,
    } as unknown as Selection);

    act(() => {
      result.current.handleSelectionChanged();
    });

    expect(result.current.interaction).toBeNull();
  });

  it('resolves a selection through the same rules, on the page it started in', () => {
    const six = buildPage(6, ['harbour lighthouse']);
    const seven = buildPage(7, ['anchorage jetty']);

    registry.register(six.live);
    registry.register(seven.live);

    const { result } = render();

    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: seven.spans[0]?.firstChild ?? null,
      anchorOffset: 11,
    } as unknown as Selection);

    act(() => {
      result.current.handleSelectionChanged();
    });

    expect(result.current.interaction?.pageNumber).toBe(7);
    expect(result.current.interaction?.source).toBe('selection');
    expect(word(result.current)).toBe('jetty');
  });
});
