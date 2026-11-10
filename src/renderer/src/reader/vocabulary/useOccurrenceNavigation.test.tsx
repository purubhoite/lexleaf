/** @vitest-environment jsdom */
import { act, renderHook, waitFor, type RenderHookResult } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createPageRegistry, type LivePage, type PageRegistry } from '../interaction/pageRegistry';

import {
  useOccurrenceNavigation,
  type NavigationOutcome,
  type OccurrenceNavigation,
  type OccurrenceTarget,
} from './useOccurrenceNavigation';

/**
 * Going back to where a word was met.
 *
 * Three outcomes have to stay distinguishable — the exact place, an
 * approximate one, and honestly not there any more — and a document that
 * cannot be opened has to say so rather than leave the reader waiting.
 */

const DOCUMENT_ID = 'doc-a';
const PAGE_TEXT = 'Equanimity is not indifference. The equanimity of a reader is quieter.';

const livePage = (text = PAGE_TEXT, pageNumber = 12, generation = 1): LivePage => {
  const container = document.createElement('div');
  const element = document.createElement('span');

  element.textContent = text;
  container.append(element);
  document.body.append(container);

  return {
    documentId: DOCUMENT_ID,
    pageNumber,
    generation,
    scale: 1,
    container,
    layer: {
      segments: [{ text, endsLine: true }],
      segmentOf: new Map([[element, 0]]),
      elements: [element],
    },
  };
};

const target = (patch: Partial<OccurrenceTarget> = {}): OccurrenceTarget => ({
  itemId: 'item-1',
  word: 'equanimity',
  normalized: 'equanimity',
  documentId: DOCUMENT_ID,
  documentName: 'Meditations.pdf',
  page: 12,
  charStart: 0,
  charEnd: 10,
  pageOffsetFraction: 0.25,
  ...patch,
});

interface Harness {
  readonly hook: RenderHookResult<OccurrenceNavigation, unknown>;
  readonly registry: PageRegistry;
  readonly outcomes: NavigationOutcome[];
  readonly opened: string[];
  readonly places: { page: number; fraction: number | null }[];
}

const mount = (
  options: {
    readonly target?: OccurrenceTarget | null;
    readonly documentId?: string | null;
    readonly documentFailed?: boolean;
  } = {},
): Harness => {
  const registry = createPageRegistry();
  const outcomes: NavigationOutcome[] = [];
  const opened: string[] = [];
  const places: { page: number; fraction: number | null }[] = [];

  const hook = renderHook(() =>
    useOccurrenceNavigation({
      target: options.target === undefined ? target() : options.target,
      documentId: options.documentId === undefined ? DOCUMENT_ID : options.documentId,
      documentFailed: options.documentFailed ?? false,
      registry,
      openDocument: (documentId): Promise<void> => {
        opened.push(documentId);

        return Promise.resolve();
      },
      goToPlace: (page, fraction): void => {
        places.push({ page, fraction });
      },
      onOutcome: (outcome): void => {
        outcomes.push(outcome);
      },
    }),
  );

  return { hook, registry, outcomes, opened, places };
};

describe('returning to a saved occurrence', () => {
  it('does nothing at all without a target', () => {
    const { outcomes, opened, places, hook } = mount({ target: null });

    expect(outcomes).toHaveLength(0);
    expect(opened).toHaveLength(0);
    expect(places).toHaveLength(0);
    expect(hook.result.current.highlight).toBeNull();
  });

  it('asks for the document by content identity when another one is open', async () => {
    const { opened } = mount({ documentId: 'some-other-document' });

    await waitFor(() => {
      expect(opened).toEqual([DOCUMENT_ID]);
    });
  });

  it('says the document is unavailable rather than waiting for ever', async () => {
    const { outcomes } = mount({ documentId: null, documentFailed: true });

    await waitFor(() => {
      expect(outcomes).toEqual([{ kind: 'document-unavailable' }]);
    });
  });

  it('uses the stored fraction as a scroll hint for the page', async () => {
    const { places } = mount();

    await waitFor(() => {
      expect(places[0]).toEqual({ page: 12, fraction: 0.25 });
    });
  });

  it('decides nothing until the page has actually been rendered', async () => {
    const { outcomes, registry, hook } = mount();

    await waitFor(() => {
      expect(outcomes).toHaveLength(0);
    });
    expect(hook.result.current.highlight).toBeNull();

    act(() => {
      registry.register(livePage());
    });

    await waitFor(() => {
      expect(outcomes).toEqual([{ kind: 'exact' }]);
    });
  });

  it('highlights the saved range when the word is still there', async () => {
    const { registry, hook, outcomes } = mount();

    act(() => {
      registry.register(livePage());
    });

    await waitFor(() => {
      expect(hook.result.current.highlight).toEqual({
        pageNumber: 12,
        start: 0,
        end: 10,
        approximate: false,
      });
    });
    expect(outcomes).toEqual([{ kind: 'exact' }]);
  });

  it('offers the first match and admits it is approximate when the text has moved', async () => {
    const { registry, hook, outcomes } = mount({
      target: target({ charStart: 400, charEnd: 410 }),
    });

    act(() => {
      registry.register(livePage());
    });

    await waitFor(() => {
      expect(outcomes).toEqual([{ kind: 'approximate' }]);
    });
    expect(hook.result.current.highlight).toEqual({
      pageNumber: 12,
      start: 0,
      end: 10,
      approximate: true,
    });
  });

  it('says the word is not on the page any more rather than guessing', async () => {
    const { registry, hook, outcomes } = mount();

    act(() => {
      registry.register(livePage('This page says something else entirely.'));
    });

    await waitFor(() => {
      expect(outcomes).toEqual([{ kind: 'not-on-page' }]);
    });
    expect(hook.result.current.highlight).toBeNull();
  });

  it('drops the highlight when the page it belonged to is re-rendered away', async () => {
    const { registry, hook } = mount();

    act(() => {
      registry.register(livePage());
    });

    await waitFor(() => {
      expect(hook.result.current.highlight).not.toBeNull();
    });

    act(() => {
      registry.release(12, 1);
    });

    await waitFor(() => {
      expect(hook.result.current.highlight).toBeNull();
    });
  });

  it('survives a new generation of the same page without a stale highlight', async () => {
    const { registry, hook } = mount();

    act(() => {
      registry.register(livePage());
    });
    await waitFor(() => {
      expect(hook.result.current.highlight?.start).toBe(0);
    });

    act(() => {
      registry.register(livePage('A reprinted page: equanimity sits later now.', 12, 2));
    });

    await waitFor(() => {
      expect(hook.result.current.highlight).toEqual({
        pageNumber: 12,
        start: 18,
        end: 28,
        approximate: true,
      });
    });
  });

  it('can be dismissed, and stays dismissed for that target', async () => {
    const { registry, hook } = mount();

    act(() => {
      registry.register(livePage());
    });
    await waitFor(() => {
      expect(hook.result.current.highlight).not.toBeNull();
    });

    act(() => {
      hook.result.current.clear();
    });

    expect(hook.result.current.highlight).toBeNull();
  });

  it('reports each journey once, not once per render', async () => {
    const { registry, outcomes, hook } = mount();

    act(() => {
      registry.register(livePage());
    });

    await waitFor(() => {
      expect(outcomes).toHaveLength(1);
    });

    act(() => {
      hook.rerender();
    });
    act(() => {
      hook.rerender();
    });

    expect(outcomes).toHaveLength(1);
  });
});
