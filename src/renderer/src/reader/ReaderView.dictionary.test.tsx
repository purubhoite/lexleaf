/**
 * @vitest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DictionaryResult } from '@core/dictionary/types';
import type { OpenedPdf, PdfEngine } from '@core/pdf/pdfEngine';
import { EMPTY_READER_STATE_SNAPSHOT } from '@shared/ipc/contracts';
import type { DesktopBridge, DocumentRequestResult } from '@shared/ipc/contracts';

import { readTextLayer } from './pdf/textLayerIndex';
import { unconfiguredAiBridge } from '../testing/aiBridgeStub';
import { unavailableVocabularyBridge } from '../testing/vocabularyBridgeStub';

/**
 * How the reader asks for a definition, and how it stops asking.
 *
 * These are the wiring tests: the gesture rules live in `ReaderView`, not in
 * the hook or the popup, and the rule that matters most is that a *single*
 * click still does exactly what it did in Milestone 2. The PDF engine and
 * the page renderer are replaced — jsdom has neither a canvas nor layout —
 * but the registry, the interaction routes, the hook and the popup are all
 * the real ones.
 */

const PAGE_TEXT = 'harbour lighthouse';

const fakeDocument = (pageCount = 2): OpenedPdf => ({
  pageCount,
  label: 'harbour.pdf',
  getPageText: (pageNumber: number) =>
    Promise.resolve({
      pageNumber,
      segments: [{ text: PAGE_TEXT, endsLine: false }],
      hasTextLayer: true,
    }),
  getPageSize: () => Promise.resolve({ width: 600, height: 800, rotation: 0 }),
  getNativePage: () => Promise.resolve({}),
  close: () => Promise.resolve(),
});

vi.mock('./pdf/rendererEngine', () => ({
  createRendererPdfEngine: (): PdfEngine => ({
    name: 'fake',
    version: '0',
    open: () => Promise.resolve({ ok: true, value: fakeDocument() }),
  }),
}));

interface FakeRender {
  readonly completed: Promise<{ layer: ReturnType<typeof readTextLayer>; milliseconds: number }>;
  cancel(): void;
}

vi.mock('./pdf/renderPage', () => ({
  renderPage: ({ textLayerContainer }: { textLayerContainer: HTMLElement }): FakeRender => {
    const span = document.createElement('span');

    span.setAttribute('role', 'presentation');
    span.textContent = PAGE_TEXT;
    textLayerContainer.replaceChildren(span);

    return {
      completed: Promise.resolve({ layer: readTextLayer(textLayerContainer), milliseconds: 1 }),
      cancel: (): void => undefined,
    };
  },
}));

const { ReaderView } = await import('./ReaderView');

const definition = (headword: string): DictionaryResult => ({
  status: 'found',
  queried: headword,
  headword,
  resolvedBy: 'exact',
  senses: [
    {
      partOfSpeech: 'noun',
      definition: 'A tower with a light that warns ships.',
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
});

const lookUps: string[] = [];

const createBridge = (overrides: Partial<DesktopBridge> = {}): DesktopBridge => ({
  getAppInfo: () =>
    Promise.resolve({ name: 'test', version: '0', electronVersion: '0', chromeVersion: '0' }),
  openDocumentDialog: () => Promise.resolve<DocumentRequestResult>({ status: 'none' }),
  getInitialDocument: () =>
    Promise.resolve<DocumentRequestResult>({
      status: 'opened',
      document: {
        id: 'doc-1',
        name: 'harbour.pdf',
        sizeBytes: 10,
        bytes: new Uint8Array([1, 2, 3]),
        position: null,
      },
    }),
  openRecentDocument: () => Promise.resolve<DocumentRequestResult>({ status: 'none' }),
  getReaderState: () => Promise.resolve(EMPTY_READER_STATE_SNAPSHOT),
  saveReadingPosition: () => Promise.resolve('ok' as const),
  forgetDocument: () => Promise.resolve('ok' as const),
  savePreferences: () => Promise.resolve('ok' as const),
  lookUpWord: (query): Promise<DictionaryResult> => {
    lookUps.push(query.normalized);

    return Promise.resolve(definition(query.normalized));
  },
  vocabulary: unavailableVocabularyBridge(),
  ai: unconfiguredAiBridge(),
  ...overrides,
});

// eslint-disable-next-line @typescript-eslint/unbound-method -- restored verbatim below.
const originalRects = Range.prototype.getClientRects;

/** jsdom measures nothing, so the word is given a rectangle to point at. */
const measureWords = (): void => {
  Range.prototype.getClientRects = function getClientRects(): DOMRectList {
    const list: DOMRect[] = [new DOMRect(10, 20, 60, 14)];

    return Object.assign(list, {
      item: (index: number): DOMRect | null => list[index] ?? null,
    });
  };
};

/**
 * jsdom implements neither hit-testing service the pointer route needs, so
 * the test plays the browser: the pointer is always over the page's text.
 */
const supplyHitTesting = (): void => {
  const browser = document as unknown as {
    elementFromPoint: () => Element | null;
    caretPositionFromPoint: () => { offsetNode: Node; offset: number } | null;
  };

  browser.elementFromPoint = (): Element | null => document.querySelector('.textLayer span');
  browser.caretPositionFromPoint = (): { offsetNode: Node; offset: number } | null => {
    const node = document.querySelector('.textLayer span')?.firstChild ?? null;

    return node === null ? null : { offsetNode: node, offset: 10 };
  };
};

/** Puts the caret inside "lighthouse" on the first rendered page. */
const selectWord = (offset = 10): void => {
  const span = document.querySelector('.textLayer span');
  const node = span?.firstChild ?? null;

  if (node === null) {
    throw new Error('the page has not rendered its text layer');
  }

  const range = document.createRange();

  range.setStart(node, offset);
  range.setEnd(node, offset + 1);

  const selection = window.getSelection();

  selection?.removeAllRanges();
  selection?.addRange(range);
};

const openReader = async (bridge: DesktopBridge = createBridge()): Promise<void> => {
  render(<ReaderView bridge={bridge} />);

  await waitFor(() => {
    expect(document.querySelector('.textLayer span')).not.toBeNull();
  });
};

const askForDefinition = async (): Promise<void> => {
  const scroller = screen.getByRole('region', { name: 'Document' });

  selectWord();
  fireEvent.doubleClick(scroller);

  await waitFor(() => {
    expect(screen.getByTestId('dictionary-popup')).toBeDefined();
  });
};

beforeEach(() => {
  lookUps.length = 0;
  measureWords();
  supplyHitTesting();
});

afterEach(() => {
  cleanup();
  Range.prototype.getClientRects = originalRects;
  vi.restoreAllMocks();
});

describe('ReaderView: asking what a word means', () => {
  it('opens a definition on a double-click', async () => {
    await openReader();
    await askForDefinition();

    expect(lookUps).toEqual(['lighthouse']);
    expect(screen.getByRole('dialog', { name: 'Definition of lighthouse' })).toBeDefined();
  });

  it('leaves a single click doing exactly what it did before', async () => {
    await openReader();

    const scroller = screen.getByRole('region', { name: 'Document' });

    selectWord();
    fireEvent.pointerDown(scroller, { clientX: 20, clientY: 20 });
    fireEvent.mouseUp(scroller);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId('dictionary-popup')).toBeNull();
    expect(lookUps).toEqual([]);
  });

  it('opens a definition from the keyboard', async () => {
    await openReader();

    const scroller = screen.getByRole('region', { name: 'Document' });

    // Alt with an arrow key walks the words; Enter asks about the one under
    // the cursor.
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
    fireEvent.keyDown(window, { key: 'Enter' });
    void scroller;

    await waitFor(() => {
      expect(screen.getByTestId('dictionary-popup')).toBeDefined();
    });

    expect(lookUps).toEqual(['harbour']);
  });

  it('closes on Escape, and the reader keeps their word', async () => {
    await openReader();
    await askForDefinition();

    fireEvent.keyDown(screen.getByTestId('dictionary-popup'), { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('dictionary-popup')).toBeNull();
    });
  });

  it('closes when the reader clicks somewhere else', async () => {
    await openReader();
    await askForDefinition();

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(screen.queryByTestId('dictionary-popup')).toBeNull();
    });
  });

  it('closes when the search panel opens', async () => {
    await openReader();
    await askForDefinition();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });

    await waitFor(() => {
      expect(screen.queryByTestId('dictionary-popup')).toBeNull();
    });
  });

  it('closes when the word it points at stops being measurable', async () => {
    await openReader();
    await askForDefinition();

    Range.prototype.getClientRects = originalRects;

    // Any re-render recomputes the anchor; a scroll is the cheapest one.
    fireEvent.scroll(screen.getByRole('region', { name: 'Document' }));
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });

    await waitFor(() => {
      expect(screen.queryByTestId('dictionary-popup')).toBeNull();
    });
  });

  it('does not scroll the document to show the popup', async () => {
    await openReader();

    const scroller = screen.getByRole('region', { name: 'Document' });
    const before = scroller.scrollTop;

    await askForDefinition();

    expect(scroller.scrollTop).toBe(before);
  });

  it('reports an unavailable dictionary without disturbing the reader', async () => {
    await openReader(
      createBridge({
        lookUpWord: () =>
          Promise.resolve<DictionaryResult>({ status: 'unavailable', reason: 'not-installed' }),
      }),
    );
    await askForDefinition();

    expect(screen.getByTestId('dictionary-unavailable').textContent).toBe(
      'The dictionary could not be loaded.',
    );
    expect(document.querySelector('.textLayer span')).not.toBeNull();
  });
});
