import { describe, expect, it } from 'vitest';

import {
  initialPageRenderState,
  isPageRendered,
  pageRenderReducer,
  type PageRenderEvent,
  type PageRenderState,
} from './pageLifecycle';

const apply = (
  events: readonly PageRenderEvent[],
  from = initialPageRenderState,
): PageRenderState => events.reduce(pageRenderReducer, from);

describe('page render lifecycle', () => {
  it('starts idle, having rendered nothing', () => {
    expect(initialPageRenderState).toEqual({ phase: 'idle', generation: 0, message: null });
    expect(isPageRendered(initialPageRenderState)).toBe(false);
  });

  it('walks idle → loading → rendered', () => {
    const state = apply([
      { type: 'start', generation: 1 },
      { type: 'rendered', generation: 1 },
    ]);

    expect(state).toEqual({ phase: 'rendered', generation: 1, message: null });
    expect(isPageRendered(state)).toBe(true);
  });

  it('records why a render failed', () => {
    const state = apply([
      { type: 'start', generation: 1 },
      { type: 'failed', generation: 1, message: 'Page 4 could not be drawn.' },
    ]);

    expect(state).toEqual({
      phase: 'failed',
      generation: 1,
      message: 'Page 4 could not be drawn.',
    });
    expect(isPageRendered(state)).toBe(false);
  });

  it('drops a result from a superseded attempt', () => {
    const state = apply([
      { type: 'start', generation: 1 },
      { type: 'start', generation: 2 },
      { type: 'rendered', generation: 1 },
    ]);

    expect(state).toEqual({ phase: 'loading', generation: 2, message: null });
  });

  it('drops a failure from a superseded attempt, so a stale error cannot surface', () => {
    const state = apply([
      { type: 'start', generation: 1 },
      { type: 'start', generation: 2 },
      { type: 'failed', generation: 1, message: 'cancelled' },
    ]);

    expect(state.phase).toBe('loading');
    expect(state.message).toBeNull();
  });

  it('ignores a late result that arrives after the page has already rendered', () => {
    const rendered = apply([
      { type: 'start', generation: 3 },
      { type: 'rendered', generation: 3 },
    ]);

    expect(pageRenderReducer(rendered, { type: 'rendered', generation: 2 })).toBe(rendered);
    expect(pageRenderReducer(rendered, { type: 'failed', generation: 2, message: 'stale' })).toBe(
      rendered,
    );
  });

  it('refuses to restart a page from an older attempt', () => {
    const current = apply([{ type: 'start', generation: 5 }]);

    expect(pageRenderReducer(current, { type: 'start', generation: 4 })).toBe(current);
  });

  it('accepts a repeated start for the same generation, as a remount does', () => {
    const current = apply([
      { type: 'start', generation: 2 },
      { type: 'rendered', generation: 2 },
    ]);

    expect(pageRenderReducer(current, { type: 'start', generation: 2 })).toEqual({
      phase: 'loading',
      generation: 2,
      message: null,
    });
  });

  it('returns to idle when the page is recycled', () => {
    const state = apply([
      { type: 'start', generation: 7 },
      { type: 'rendered', generation: 7 },
      { type: 'reset' },
    ]);

    expect(state).toEqual(initialPageRenderState);
  });

  it('survives a full recycle-and-re-render cycle', () => {
    const state = apply([
      { type: 'start', generation: 1 },
      { type: 'rendered', generation: 1 },
      { type: 'reset' },
      { type: 'start', generation: 1 },
      { type: 'failed', generation: 1, message: 'cancelled' },
      { type: 'start', generation: 2 },
      { type: 'rendered', generation: 2 },
    ]);

    expect(state).toEqual({ phase: 'rendered', generation: 2, message: null });
  });
});
