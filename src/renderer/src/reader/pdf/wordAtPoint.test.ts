/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';

import { readTextLayer } from './textLayerIndex';
import { hitTestWord, type HitResult } from './wordAtPoint';

/**
 * These tests cover the guarantees that do not depend on glyph geometry:
 * the pointer must land on a known text run, and the caret the browser
 * reports must belong to that same run. Everything else is neutral.
 *
 * jsdom implements neither `caretPositionFromPoint` nor layout, so those two
 * browser services are supplied explicitly here. The DOM, the text layer
 * index and the decision logic under test are real. Geometry-dependent
 * behaviour is covered by `pickCharacterIndex.test.ts` (pure) and by manual
 * verification in the built application (docs/PDF_SPIKE_REPORT.md).
 */

interface Services {
  readonly elementAt: Element | null;
  readonly caret?: { readonly node: Node; readonly offset: number };
}

const buildLayer = (): { container: HTMLElement; spans: HTMLElement[] } => {
  const container = document.createElement('div');

  container.className = 'textLayer';

  const first = document.createElement('span');
  first.setAttribute('role', 'presentation');
  first.textContent = 'harbour lighthouse';

  const second = document.createElement('span');
  second.setAttribute('role', 'presentation');
  second.textContent = 'keeper';

  container.append(first, second);

  return { container, spans: [first, second] };
};

const hitWith = (container: HTMLElement, services: Services): HitResult => {
  const layer = readTextLayer(container);
  const ownerDocument = {
    elementFromPoint: (): Element | null => services.elementAt,
    caretPositionFromPoint: (): { offsetNode: Node; offset: number } | null =>
      services.caret === undefined
        ? null
        : { offsetNode: services.caret.node, offset: services.caret.offset },
  } as unknown as Document;

  return hitTestWord(ownerDocument, layer, { clientX: 10, clientY: 10 });
};

describe('hitTestWord', () => {
  it('reports nothing when the pointer is over no element at all', () => {
    const { container } = buildLayer();

    expect(hitWith(container, { elementAt: null })).toEqual({
      kind: 'miss',
      reason: 'nothing-at-point',
    });
  });

  it('reports nothing when the pointer is outside the text layer', () => {
    const { container } = buildLayer();
    const elsewhere = document.createElement('div');

    expect(hitWith(container, { elementAt: elsewhere })).toEqual({
      kind: 'miss',
      reason: 'outside-text-layer',
    });
  });

  it('reports nothing when the browser gives no caret position', () => {
    const { container, spans } = buildLayer();

    expect(hitWith(container, { elementAt: spans[0] as HTMLElement })).toEqual({
      kind: 'miss',
      reason: 'no-caret-position',
    });
  });

  it('refuses a caret that belongs to a different run than the pointer', () => {
    const { container, spans } = buildLayer();
    const otherText = spans[1]?.firstChild as Node;

    expect(
      hitWith(container, {
        elementAt: spans[0] as HTMLElement,
        caret: { node: otherText, offset: 1 },
      }),
    ).toEqual({ kind: 'miss', reason: 'caret-in-another-run' });
  });

  it('refuses a caret that is not inside a text node', () => {
    const { container, spans } = buildLayer();

    expect(
      hitWith(container, {
        elementAt: spans[0] as HTMLElement,
        caret: { node: spans[0] as Node, offset: 0 },
      }),
    ).toEqual({ kind: 'miss', reason: 'caret-in-another-run' });
  });

  it('declines rather than guesses when no character rectangle contains the pointer', () => {
    // jsdom performs no layout, so a range has no rectangle. An empty
    // rectangle is exactly the "the pointer is not on a glyph" case, which
    // the hit test must refuse instead of returning the nearest word.
    Range.prototype.getBoundingClientRect = (): DOMRect =>
      ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;

    const { container, spans } = buildLayer();
    const text = spans[0]?.firstChild as Node;

    expect(
      hitWith(container, { elementAt: spans[0] as HTMLElement, caret: { node: text, offset: 3 } }),
    ).toEqual({ kind: 'miss', reason: 'pointer-between-characters' });
  });
});
