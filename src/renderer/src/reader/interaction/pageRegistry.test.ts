/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readTextLayer } from '../pdf/textLayerIndex';

import {
  createPageRegistry,
  nextRenderGeneration,
  PAGE_NUMBER_ATTRIBUTE,
  type LivePage,
  type PageRegistry,
} from './pageRegistry';

interface BuiltPage {
  readonly live: LivePage;
  readonly container: HTMLElement;
  readonly spans: readonly HTMLElement[];
}

const buildPage = (
  pageNumber: number,
  words: readonly string[],
  options: { readonly documentId?: string; readonly generation?: number } = {},
): BuiltPage => {
  const container = document.createElement('div');

  container.setAttribute(PAGE_NUMBER_ATTRIBUTE, String(pageNumber));

  const layerElement = document.createElement('div');

  layerElement.className = 'textLayer';

  const spans = words.map((text) => {
    const span = document.createElement('span');

    span.setAttribute('role', 'presentation');
    span.textContent = text;
    layerElement.append(span);

    return span;
  });

  container.append(layerElement);
  document.body.append(container);

  return {
    container,
    spans,
    live: {
      documentId: options.documentId ?? 'doc-1',
      pageNumber,
      generation: options.generation ?? nextRenderGeneration(),
      scale: 1,
      container,
      layer: readTextLayer(layerElement),
    },
  };
};

describe('page registry', () => {
  let registry: PageRegistry;

  beforeEach(() => {
    document.body.innerHTML = '';
    registry = createPageRegistry();
  });

  it('hands out strictly increasing render generations', () => {
    const first = nextRenderGeneration();
    const second = nextRenderGeneration();
    const third = nextRenderGeneration();

    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('starts empty', () => {
    expect(registry.livePages()).toEqual([]);
    expect(registry.get(1)).toBeNull();
    expect(registry.pageOfNode(null)).toBeNull();
  });

  it('keeps several pages live at once, in reading order', () => {
    registry.register(buildPage(7, ['seven']).live);
    registry.register(buildPage(5, ['five']).live);
    registry.register(buildPage(6, ['six']).live);

    expect(registry.livePages().map((page) => page.pageNumber)).toEqual([5, 6, 7]);
  });

  it('finds the page that owns a node, not the page that happens to be current', () => {
    const six = buildPage(6, ['harbour']);
    const seven = buildPage(7, ['lighthouse']);

    registry.register(six.live);
    registry.register(seven.live);

    expect(registry.pageOfNode(seven.spans[0] ?? null)?.pageNumber).toBe(7);
    expect(registry.pageOfNode(seven.spans[0]?.firstChild ?? null)?.pageNumber).toBe(7);
    expect(registry.pageOfNode(six.spans[0] ?? null)?.pageNumber).toBe(6);
  });

  it('reports nothing for a node outside every page', () => {
    registry.register(buildPage(1, ['word']).live);

    const stray = document.createElement('p');

    document.body.append(stray);

    expect(registry.pageOfNode(stray)).toBeNull();
  });

  it('refuses a node from a detached container that shares a page number', () => {
    const current = buildPage(4, ['current']);

    registry.register(current.live);

    // A container left over from an earlier render of the same page.
    const previous = buildPage(4, ['previous']);

    expect(registry.pageOfNode(previous.spans[0] ?? null)).toBeNull();
    expect(registry.pageOfNode(current.spans[0] ?? null)?.pageNumber).toBe(4);
  });

  it('replaces the entry for a page when it is rendered again', () => {
    const first = buildPage(3, ['old']);

    registry.register(first.live);

    const second = buildPage(3, ['new']);

    registry.register(second.live);

    expect(registry.livePages()).toHaveLength(1);
    expect(registry.get(3)?.generation).toBe(second.live.generation);
    expect(registry.pageOfNode(first.spans[0] ?? null)).toBeNull();
  });

  it('releases a page it still owns', () => {
    const page = buildPage(2, ['word']);

    registry.register(page.live);
    registry.release(2, page.live.generation);

    expect(registry.get(2)).toBeNull();
    expect(registry.livePages()).toEqual([]);
  });

  it('ignores the cleanup of a render that has already been superseded', () => {
    const first = buildPage(2, ['old']);
    const second = buildPage(2, ['new']);

    registry.register(first.live);
    registry.register(second.live);

    // The first render's cleanup runs after the second has registered.
    registry.release(2, first.live.generation);

    expect(registry.get(2)?.generation).toBe(second.live.generation);
  });

  it('ignores a release for a page that was never registered', () => {
    expect(() => {
      registry.release(9, 1);
    }).not.toThrow();
    expect(registry.version()).toBe(0);
  });

  it('notifies subscribers whenever the live set changes, and stops on unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    const page = buildPage(1, ['word']);

    registry.register(page.live);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.version()).toBe(1);

    registry.release(1, page.live.generation);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.version()).toBe(2);

    // A no-op release notifies nobody.
    registry.release(1, page.live.generation);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    registry.register(buildPage(1, ['again']).live);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('exposes the text of each live page separately', () => {
    const six = buildPage(6, ['harbour ']);
    const seven = buildPage(7, ['lighthouse ']);

    registry.register(six.live);
    registry.register(seven.live);

    expect(registry.get(6)?.layer.segments[0]?.text).toBe('harbour ');
    expect(registry.get(7)?.layer.segments[0]?.text).toBe('lighthouse ');
  });
});
