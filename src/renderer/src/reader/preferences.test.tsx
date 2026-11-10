/**
 * @vitest-environment jsdom
 */

import { DEFAULT_PREFERENCES, type Preferences } from '@core/persistence/preferences';
import {
  emptyReaderState,
  lastUsedZoom,
  rememberOpen,
  rememberPosition,
} from '@core/persistence/readerState';
import type { ReadingPosition, ZoomState } from '@core/persistence/types';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OpenedPdf, PdfEngine } from '@core/pdf/pdfEngine';
import { EMPTY_READER_STATE_SNAPSHOT } from '@shared/ipc/contracts';
import type {
  DesktopBridge,
  DocumentRequestResult,
  ReaderStateSnapshot,
} from '@shared/ipc/contracts';

import { readTextLayer } from './pdf/textLayerIndex';
import { unconfiguredAiBridge } from '../testing/aiBridgeStub';
import { unavailableVocabularyBridge } from '../testing/vocabularyBridgeStub';

/**
 * The two preferences the reader itself answers to (ADR-031, 6.8).
 *
 * Default zoom and the diagnostics disclosure. The engine and the page
 * renderer are replaced exactly as the other ReaderView tests replace
 * them — jsdom has no canvas and no layout — so what is under test is the
 * reader's own decision about where a document starts and what is open.
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

/**
 * The last-used zoom a *real* main process would send with this open.
 *
 * Not a literal: the value is computed from the reader state through the
 * same core functions `ReaderStateService.openPath` uses, with the
 * document about to open already written into the state by `rememberOpen`
 * — the ordering that made the first implementation of `last-used`
 * answer with the new document's own starting zoom. A hand-written
 * fixture here would let the renderer pass against a payload the
 * application never produces, which is exactly what the 6.8 closure audit
 * found.
 */
const lastUsedZoomFromRealState = (previous: ZoomState | null): ZoomState | null => {
  const earlier =
    previous === null
      ? emptyReaderState()
      : rememberPosition(
          rememberOpen(emptyReaderState(), {
            id: 'doc-0',
            path: '/books/previous.pdf',
            name: 'previous.pdf',
            sizeBytes: 20,
            pageCount: 4,
            at: '2026-05-01T09:00:00.000Z',
          }),
          'doc-0',
          { page: 3, pageOffsetFraction: 0.25, zoom: previous },
        );

  const afterThisOpenWasRecorded = rememberOpen(earlier, {
    id: 'doc-1',
    path: '/books/harbour.pdf',
    name: 'harbour.pdf',
    sizeBytes: 10,
    pageCount: null,
    at: '2026-05-01T10:00:00.000Z',
  });

  return lastUsedZoom(afterThisOpenWasRecorded, 'doc-1');
};

const createBridge = (
  position: ReadingPosition | null = null,
  lastUsed: ZoomState | null = null,
  snapshot: Partial<ReaderStateSnapshot> = {},
): DesktopBridge => ({
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
        position,
        lastUsedZoom: lastUsed,
      },
    }),
  openRecentDocument: () => Promise.resolve<DocumentRequestResult>({ status: 'none' }),
  getReaderState: () => Promise.resolve({ ...EMPTY_READER_STATE_SNAPSHOT, ...snapshot }),
  saveReadingPosition: () => Promise.resolve('ok' as const),
  forgetDocument: () => Promise.resolve('ok' as const),
  savePreferences: () => Promise.resolve('ok' as const),
  lookUpWord: () =>
    Promise.resolve({ status: 'unavailable' as const, reason: 'not-installed' as const }),
  vocabulary: unavailableVocabularyBridge(),
  ai: unconfiguredAiBridge(),
});

const openReader = async (
  preferences: Partial<Preferences> = {},
  bridge: DesktopBridge = createBridge(),
): Promise<void> => {
  render(<ReaderView bridge={bridge} preferences={{ ...DEFAULT_PREFERENCES, ...preferences }} />);

  await waitFor(() => {
    expect(document.querySelector('.textLayer span')).not.toBeNull();
  });
};

const zoomSelect = (): HTMLSelectElement =>
  screen.getByRole<HTMLSelectElement>('combobox', { name: 'Zoom level' });

const diagnostics = (): HTMLDetailsElement =>
  screen.getByTestId<HTMLDetailsElement>('developer-diagnostics');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the default zoom preference', () => {
  it('opens a new document at fit width by default', async () => {
    await openReader();

    expect(zoomSelect().value).toBe('fit-width');
  });

  it('opens a new document at fit page when that is the preference', async () => {
    await openReader({ defaultZoomMode: 'fit-page' });

    expect(zoomSelect().value).toBe('fit-page');
  });

  it('opens at the zoom of the last document read when asked to', async () => {
    const lastUsed = lastUsedZoomFromRealState({ mode: 'fixed', scale: 1.5 });

    // The state the main process reads from really does answer 1.5 even
    // though the document being opened is already the most recent one.
    expect(lastUsed).toEqual({ mode: 'fixed', scale: 1.5 });

    await openReader({ defaultZoomMode: 'last-used' }, createBridge(null, lastUsed));

    expect(zoomSelect().value).toBe('1.5');
  });

  it('opens at the last used fit mode, not only at a fixed scale', async () => {
    await openReader(
      { defaultZoomMode: 'last-used' },
      createBridge(null, lastUsedZoomFromRealState({ mode: 'fit-page', scale: 1 })),
    );

    expect(zoomSelect().value).toBe('fit-page');
  });

  it('falls back to the default when nothing has been read yet', async () => {
    const lastUsed = lastUsedZoomFromRealState(null);

    // A first-ever document is its own most recent document; the state
    // still has no earlier zoom to offer, and must not offer this one's.
    expect(lastUsed).toBeNull();

    await openReader({ defaultZoomMode: 'last-used' }, createBridge(null, lastUsed));

    expect(zoomSelect().value).toBe('fit-width');
  });

  it('ignores a last-used zoom the payload did not carry', async () => {
    /*
     * Nothing in the renderer may fall back to an ambient snapshot value
     * for this: a payload without a hint means the default zoom, not a
     * zoom borrowed from whatever the reader state last reported.
     */
    await openReader(
      { defaultZoomMode: 'last-used' },
      createBridge(null, null, {
        recents: [
          {
            id: 'doc-0',
            name: 'previous.pdf',
            sizeBytes: 20,
            pageCount: 4,
            lastPage: 3,
            lastOpenedAt: '2026-05-01T09:00:00.000Z',
            available: true,
          },
        ],
      }),
    );

    expect(zoomSelect().value).toBe('fit-width');
  });

  it('lets a remembered position win over the preference', async () => {
    /*
     * ADR-031 and ADR-016 together: the default zoom describes a document
     * the reader has never opened, and must not overrule the place and
     * zoom a document was actually left at.
     */
    await openReader(
      { defaultZoomMode: 'fit-page' },
      createBridge(
        { page: 2, pageOffsetFraction: 0, zoom: { mode: 'fixed', scale: 1.25 } },
        lastUsedZoomFromRealState({ mode: 'fixed', scale: 2 }),
      ),
    );

    expect(zoomSelect().value).toBe('1.25');
  });

  it('still lets the reader change the zoom afterwards', async () => {
    await openReader({ defaultZoomMode: 'fit-page' });

    fireEvent.change(zoomSelect(), { target: { value: '1' } });

    expect(zoomSelect().value).toBe('1');
  });
});

describe('the developer diagnostics preference', () => {
  it('keeps the disclosure closed by default (the 6.4 design)', async () => {
    await openReader();

    expect(diagnostics().open).toBe(false);
  });

  it('starts the disclosure open when the preference says so', async () => {
    await openReader({ showDeveloperDiagnostics: 'on' });

    expect(diagnostics().open).toBe(true);
  });

  it('shows the same fields either way', async () => {
    // The preference changes what is expanded, never what exists: the
    // identifiers AC 27 protects are in the DOM in both states.
    await openReader({ showDeveloperDiagnostics: 'on' });

    for (const id of ['word-raw', 'word-normalized', 'word-page']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it('lets the reader close it by hand even when the preference opens it', async () => {
    await openReader({ showDeveloperDiagnostics: 'on' });

    const details = diagnostics();

    details.open = false;
    fireEvent(details, new Event('toggle'));

    expect(diagnostics().open).toBe(false);
  });

  it('follows a change of the preference while the reader is open', async () => {
    const bridge = createBridge();

    const { rerender } = render(
      <ReaderView bridge={bridge} preferences={{ ...DEFAULT_PREFERENCES }} />,
    );

    await waitFor(() => {
      expect(document.querySelector('.textLayer span')).not.toBeNull();
    });

    expect(diagnostics().open).toBe(false);

    rerender(
      <ReaderView
        bridge={bridge}
        preferences={{ ...DEFAULT_PREFERENCES, showDeveloperDiagnostics: 'on' }}
      />,
    );

    expect(diagnostics().open).toBe(true);
  });
});
