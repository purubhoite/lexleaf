/**
 * The life of one page in the scrolling surface.
 *
 * ```text
 * unmounted → idle → loading → rendered
 *                       ↓          ↓
 *                     failed    released (unmounted)
 * ```
 *
 * The state machine exists as a reducer, separate from React, for one
 * reason: **stale renders**. A page can be asked to render, be scrolled out
 * of view, be recycled and be asked to render again before the first attempt
 * finishes. Every attempt therefore carries a generation, and a result from
 * an older generation is dropped here, in one tested place, rather than in
 * whichever effect happens to receive it (ADR-017).
 */

export type PagePhase = 'idle' | 'loading' | 'rendered' | 'failed';

export interface PageRenderState {
  readonly phase: PagePhase;
  /** The attempt this state describes; 0 before anything has been asked for. */
  readonly generation: number;
  /** Only set in the `failed` phase. */
  readonly message: string | null;
}

export type PageRenderEvent =
  | { readonly type: 'start'; readonly generation: number }
  | { readonly type: 'rendered'; readonly generation: number }
  | { readonly type: 'failed'; readonly generation: number; readonly message: string }
  /** The page is being reused for a different document, page or scale. */
  | { readonly type: 'reset' };

export const initialPageRenderState: PageRenderState = {
  phase: 'idle',
  generation: 0,
  message: null,
};

export const pageRenderReducer = (
  state: PageRenderState,
  event: PageRenderEvent,
): PageRenderState => {
  if (event.type === 'reset') {
    return initialPageRenderState;
  }

  if (event.type === 'start') {
    // A newer attempt always wins; an older one must never restart the page.
    return event.generation >= state.generation
      ? { phase: 'loading', generation: event.generation, message: null }
      : state;
  }

  // Results are accepted only from the attempt that is currently running.
  if (event.generation !== state.generation) {
    return state;
  }

  return event.type === 'rendered'
    ? { phase: 'rendered', generation: state.generation, message: null }
    : { phase: 'failed', generation: state.generation, message: event.message };
};

export const isPageRendered = (state: PageRenderState): boolean => state.phase === 'rendered';
