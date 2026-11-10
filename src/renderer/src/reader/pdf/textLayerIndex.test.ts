// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { readTextLayer } from './textLayerIndex';

/**
 * Builds a container with the structure PDF.js produces: one span per text
 * run and a `<br role="presentation">` where a visual line ends.
 */
const layerFrom = (html: string): HTMLElement => {
  const container = document.createElement('div');

  container.innerHTML = html;

  return container;
};

describe('readTextLayer', () => {
  it('reads one segment per element', () => {
    const { segments } = readTextLayer(layerFrom('<span>Hello</span><span> world</span>'));

    expect(segments).toEqual([
      { text: 'Hello', endsLine: false },
      { text: ' world', endsLine: false },
    ]);
  });

  it('marks the segment before a line break', () => {
    const { segments } = readTextLayer(layerFrom('<span>time</span><br><span>until</span><br>'));

    expect(segments).toEqual([
      { text: 'time', endsLine: true },
      { text: 'until', endsLine: true },
    ]);
  });

  it('maps every element to its segment', () => {
    const container = layerFrom('<span>one</span><br><span>two</span>');
    const { segmentOf } = readTextLayer(container);
    const [first, , second] = [...container.childNodes];

    expect(segmentOf.get(first as Element)).toBe(0);
    expect(segmentOf.get(second as Element)).toBe(1);
    expect(segmentOf.size).toBe(2);
  });

  it('descends into marked content, which tagged PDFs nest', () => {
    const { segments, segmentOf } = readTextLayer(
      layerFrom('<span class="markedContent"><span>tagged</span><br></span><span>plain</span>'),
    );

    expect(segments).toEqual([
      { text: 'tagged', endsLine: true },
      { text: 'plain', endsLine: false },
    ]);
    expect(segmentOf.size).toBe(2);
  });

  it('ignores a line break that has nothing before it', () => {
    expect(readTextLayer(layerFrom('<br><span>text</span>')).segments).toEqual([
      { text: 'text', endsLine: false },
    ]);
  });

  it('returns nothing for an empty layer', () => {
    expect(readTextLayer(layerFrom('')).segments).toEqual([]);
  });
});
