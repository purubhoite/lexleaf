/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';

import { rangeForSpan, rectsForSpan } from './textRanges';
import { readTextLayer, type TextLayerIndex } from './textLayerIndex';

/**
 * Going from a position in the page text back to the DOM. jsdom has no
 * layout, so the rectangles themselves are verified in the built
 * application; what is tested here is which characters a span resolves to,
 * which is what decides whether a highlight sits on the right word.
 */

/** `'br'` stands for the line break PDF.js puts between visual lines. */
const buildLayer = (
  runs: readonly string[],
): { readonly layer: TextLayerIndex; readonly container: HTMLElement } => {
  const container = document.createElement('div');

  container.className = 'textLayer';

  for (const run of runs) {
    if (run === 'br') {
      container.append(document.createElement('br'));
      continue;
    }

    const span = document.createElement('span');

    span.setAttribute('role', 'presentation');
    span.textContent = run;
    container.append(span);
  }

  document.body.append(container);

  return { container, layer: readTextLayer(container) };
};

const textOf = (range: Range | null): string | null => range?.toString() ?? null;

describe('text ranges', () => {
  it('covers a span inside one run', () => {
    const { layer } = buildLayer(['harbour lighthouse']);

    expect(textOf(rangeForSpan(document, layer, 0, 7))).toBe('harbour');
    expect(textOf(rangeForSpan(document, layer, 8, 18))).toBe('lighthouse');
  });

  it('covers a span that crosses two runs', () => {
    const { layer } = buildLayer(['harbour ', 'lighthouse']);

    expect(textOf(rangeForSpan(document, layer, 4, 14))).toBe('our lighth');
  });

  it('places a span after a line break the text layer inserted', () => {
    const { layer } = buildLayer(['first line', 'br', 'second line']);
    // joinSegments inserts the newline, so the second run starts at 11.
    const range = rangeForSpan(document, layer, 11, 17);

    expect(textOf(range)).toBe('second');
  });

  it('treats an empty span as a caret rather than an error', () => {
    const { layer } = buildLayer(['harbour']);

    expect(textOf(rangeForSpan(document, layer, 3, 3))).toBe('');
  });

  it('refuses a span that runs past the end of the page text', () => {
    // Nothing is drawn rather than a highlight over an invented position.
    const { layer } = buildLayer(['harbour']);

    expect(rangeForSpan(document, layer, 4, 99)).toBeNull();
    expect(textOf(rangeForSpan(document, layer, 4, 7))).toBe('our');
  });

  it('refuses a position it cannot place rather than guessing', () => {
    const { layer } = buildLayer([]);

    expect(rangeForSpan(document, layer, 0, 3)).toBeNull();
  });

  it('refuses an element with no text node of its own', () => {
    const container = document.createElement('div');
    const span = document.createElement('span');

    // A tagged PDF can nest the text one level deeper.
    span.append(document.createElement('em'));
    container.append(span);
    document.body.append(container);

    expect(rangeForSpan(document, readTextLayer(container), 0, 1)).toBeNull();
  });

  it('draws nothing when the span cannot be placed', () => {
    const { container, layer } = buildLayer([]);

    expect(rectsForSpan(container, layer, 0, 5)).toEqual([]);
  });

  it('reports no rectangles when the browser measures none, instead of zero-sized ones', () => {
    // jsdom reports no client rects at all; a real browser reports one per
    // line. Either way nothing degenerate is ever drawn.
    const { container, layer } = buildLayer(['harbour']);

    expect(rectsForSpan(container, layer, 0, 7)).toEqual([]);
  });
});
