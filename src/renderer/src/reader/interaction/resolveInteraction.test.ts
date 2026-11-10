/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTextLayer } from '../pdf/textLayerIndex';

import {
  createPageRegistry,
  nextRenderGeneration,
  PAGE_NUMBER_ATTRIBUTE,
  type LivePage,
  type PageRegistry,
} from './pageRegistry';
import {
  isStaleInteraction,
  neutralInteraction,
  resolvePointerInteraction,
  resolveSelectionInteraction,
  resolveTextIndexInteraction,
  wordOf,
  type WordInteraction,
} from './resolveInteraction';

/**
 * These tests are about *identity*: which page an interaction belongs to and
 * whether it is still valid. jsdom has no layout, so the two browser services
 * the pointer route needs — the element at a point and the caret at a point —
 * are supplied explicitly, exactly as `wordAtPoint.test.ts` does. The
 * registry, the DOM, the text layer and the resolution logic are real.
 */

interface BuiltPage {
  readonly live: LivePage;
  readonly spans: readonly HTMLElement[];
}

const buildPage = (
  pageNumber: number,
  runs: readonly string[],
  documentId = 'doc-1',
): BuiltPage => {
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

/** A document that reports the given element and caret under the pointer. */
const pointingAt = (element: Element | null, caretOffset: number): Document =>
  ({
    elementFromPoint: (): Element | null => element,
    caretPositionFromPoint: (): { offsetNode: Node; offset: number } | null => {
      const node = element?.firstChild ?? null;

      return node === null ? null : { offsetNode: node, offset: caretOffset };
    },
  }) as unknown as Document;

const wordText = (interaction: WordInteraction | null): string | null => {
  const hit = wordOf(interaction);

  return hit !== null && hit.kind === 'word' ? hit.word.display : null;
};

let registry: PageRegistry;
// eslint-disable-next-line @typescript-eslint/unbound-method -- restored verbatim below.
const originalRect = Range.prototype.getBoundingClientRect;

beforeEach(() => {
  document.body.innerHTML = '';
  registry = createPageRegistry();
  // Every character is treated as covering the pointer, so the caret offset
  // alone decides the character. Real geometry is verified in the built app.
  Range.prototype.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 1_000, 1_000);
});

afterEach(() => {
  Range.prototype.getBoundingClientRect = originalRect;
});

describe('pointer route with several pages live', () => {
  it('resolves against the page under the pointer, not a neighbouring one', () => {
    const six = buildPage(6, ['harbour lighthouse']);
    const seven = buildPage(7, ['anchorage jetty']);

    registry.register(six.live);
    registry.register(seven.live);

    const onSeven = resolvePointerInteraction(pointingAt(seven.spans[0] ?? null, 2), registry, {
      clientX: 10,
      clientY: 10,
    });

    expect(onSeven?.pageNumber).toBe(7);
    expect(onSeven?.generation).toBe(seven.live.generation);
    expect(wordText(onSeven)).toBe('anchorage');

    const onSix = resolvePointerInteraction(pointingAt(six.spans[0] ?? null, 2), registry, {
      clientX: 10,
      clientY: 400,
    });

    expect(onSix?.pageNumber).toBe(6);
    expect(wordText(onSix)).toBe('harbour');
  });

  it('never borrows text from an adjacent page for the same character index', () => {
    const one = buildPage(1, ['alpha bravo charlie']);
    const two = buildPage(2, ['delta echo foxtrot']);

    registry.register(one.live);
    registry.register(two.live);

    const sameOffsetOnEach = [one, two].map((page) =>
      wordText(
        resolvePointerInteraction(pointingAt(page.spans[0] ?? null, 7), registry, {
          clientX: 1,
          clientY: 1,
        }),
      ),
    );

    expect(sameOffsetOnEach).toEqual(['bravo', 'echo']);
  });

  it('reports nothing when the pointer is not over any live page', () => {
    registry.register(buildPage(1, ['alpha']).live);

    const stray = document.createElement('p');

    stray.textContent = 'toolbar';
    document.body.append(stray);

    expect(
      resolvePointerInteraction(pointingAt(stray, 0), registry, { clientX: 0, clientY: 0 }),
    ).toBeNull();
    expect(
      resolvePointerInteraction(pointingAt(null, 0), registry, { clientX: 0, clientY: 0 }),
    ).toBeNull();
  });

  it('answers with a page-identified miss when the pointer is on the page but not on text', () => {
    const page = buildPage(3, ['alpha']);

    registry.register(page.live);

    const interaction = resolvePointerInteraction(pointingAt(page.live.container, 0), registry, {
      clientX: 5,
      clientY: 5,
    });

    expect(interaction?.pageNumber).toBe(3);
    expect(interaction?.hit).toEqual({ kind: 'miss', reason: 'outside-text-layer' });
  });

  it('gives a neutral answer on whitespace rather than guessing a neighbour', () => {
    const page = buildPage(2, ['alpha bravo']);

    registry.register(page.live);

    const interaction = resolvePointerInteraction(pointingAt(page.spans[0] ?? null, 5), registry, {
      clientX: 5,
      clientY: 5,
    });

    expect(interaction?.pageNumber).toBe(2);
    expect(interaction?.hit).toEqual({ kind: 'miss', reason: 'whitespace' });
  });

  it('times how long the answer took', () => {
    const page = buildPage(1, ['alpha']);

    registry.register(page.live);

    const interaction = resolvePointerInteraction(pointingAt(page.spans[0] ?? null, 1), registry, {
      clientX: 1,
      clientY: 1,
    });

    expect(interaction?.milliseconds).toBeGreaterThanOrEqual(0);
    expect(interaction?.source).toBe('pointer');
  });
});

describe('keyboard and selection routes', () => {
  it('resolves a text index on the page that owns it', () => {
    const page = buildPage(4, ['harbour ', 'lighthouse keeper']);

    registry.register(page.live);

    const interaction = resolveTextIndexInteraction(page.live, 8, 'keyboard');

    expect(interaction.source).toBe('keyboard');
    expect(interaction.pageNumber).toBe(4);
    expect(interaction.textIndex).toBe(8);
    expect(wordText(interaction)).toBe('lighthouse');
  });

  it('agrees with the pointer route about the same word', () => {
    const page = buildPage(5, ['harbour lighthouse']);

    registry.register(page.live);

    const pointer = resolvePointerInteraction(pointingAt(page.spans[0] ?? null, 10), registry, {
      clientX: 1,
      clientY: 1,
    });
    const keyboard = resolveTextIndexInteraction(page.live, 10, 'keyboard');

    expect(wordText(keyboard)).toBe(wordText(pointer));
    expect(keyboard.pageNumber).toBe(pointer?.pageNumber);
  });

  it('is neutral at an index that is not a word', () => {
    const page = buildPage(1, ['alpha   bravo']);

    registry.register(page.live);

    expect(resolveTextIndexInteraction(page.live, 6, 'keyboard').hit).toEqual({
      kind: 'miss',
      reason: 'not-a-word',
    });
  });

  it('is neutral at an index beyond the page text', () => {
    const page = buildPage(1, ['alpha']);

    registry.register(page.live);

    expect(resolveTextIndexInteraction(page.live, 9_999, 'keyboard').hit).toEqual({
      kind: 'miss',
      reason: 'not-a-word',
    });
  });

  it('resolves a selection through the same word rules, on its own page', () => {
    const six = buildPage(6, ['harbour lighthouse']);
    const seven = buildPage(7, ['anchorage jetty']);

    registry.register(six.live);
    registry.register(seven.live);

    const interaction = resolveSelectionInteraction(
      { node: seven.spans[0]?.firstChild ?? null, offset: 11, isCollapsed: false },
      registry,
    );

    expect(interaction?.source).toBe('selection');
    expect(interaction?.pageNumber).toBe(7);
    expect(wordText(interaction)).toBe('jetty');
  });

  it('reports the selection position in joined page text, across runs', () => {
    const page = buildPage(2, ['harbour ', 'lighthouse']);

    registry.register(page.live);

    const interaction = resolveSelectionInteraction(
      { node: page.spans[1]?.firstChild ?? null, offset: 2, isCollapsed: true },
      registry,
    );

    expect(interaction?.textIndex).toBe(10);
    expect(wordText(interaction)).toBe('lighthouse');
  });

  it('ignores a selection that starts outside any live page', () => {
    registry.register(buildPage(1, ['alpha']).live);

    const stray = document.createElement('p');

    stray.textContent = 'elsewhere';
    document.body.append(stray);

    expect(
      resolveSelectionInteraction(
        { node: stray.firstChild, offset: 0, isCollapsed: true },
        registry,
      ),
    ).toBeNull();
    expect(
      resolveSelectionInteraction({ node: null, offset: 0, isCollapsed: true }, registry),
    ).toBeNull();
  });

  it('builds an explicit neutral answer for a page', () => {
    const page = buildPage(8, ['alpha']);

    expect(neutralInteraction(page.live, 'pointer')).toMatchObject({
      pageNumber: 8,
      documentId: 'doc-1',
      hit: { kind: 'miss', reason: 'not-a-word' },
      textIndex: null,
    });
  });
});

describe('staleness', () => {
  it('accepts an answer whose page is still live and unchanged', () => {
    const page = buildPage(3, ['alpha']);

    registry.register(page.live);

    const interaction = resolveTextIndexInteraction(page.live, 1, 'keyboard');

    expect(isStaleInteraction(interaction, registry, 'doc-1')).toBe(false);
  });

  it('rejects an answer from a page that has been recycled', () => {
    const page = buildPage(3, ['alpha']);

    registry.register(page.live);

    const interaction = resolveTextIndexInteraction(page.live, 1, 'keyboard');

    registry.release(3, page.live.generation);

    expect(isStaleInteraction(interaction, registry, 'doc-1')).toBe(true);
  });

  it('rejects an answer from an earlier render of a page that is live again', () => {
    const first = buildPage(3, ['alpha']);

    registry.register(first.live);

    const interaction = resolveTextIndexInteraction(first.live, 1, 'keyboard');
    const second = buildPage(3, ['beta']);

    registry.register(second.live);

    expect(isStaleInteraction(interaction, registry, 'doc-1')).toBe(true);
    expect(
      isStaleInteraction(
        resolveTextIndexInteraction(second.live, 1, 'keyboard'),
        registry,
        'doc-1',
      ),
    ).toBe(false);
  });

  it('rejects an answer that belongs to a different document', () => {
    const page = buildPage(3, ['alpha'], 'doc-old');

    registry.register(page.live);

    const interaction = resolveTextIndexInteraction(page.live, 1, 'keyboard');

    expect(isStaleInteraction(interaction, registry, 'doc-new')).toBe(true);
  });

  it('wordOf is null for no interaction at all', () => {
    expect(wordOf(null)).toBeNull();
  });
});
