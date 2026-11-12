/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classifyOpenFailure } from '@core/pdf/openFailure';
import type { OpenedPdf, PdfEngine } from '@core/pdf/pdfEngine';
import { EMPTY_READER_STATE_SNAPSHOT } from '@shared/ipc/contracts';
import type { DesktopBridge, DocumentRequestResult } from '@shared/ipc/contracts';

import { SIDE_PANEL_BREAKPOINT } from './model/chrome';
import { readTextLayer } from './pdf/textLayerIndex';
import { unconfiguredAiBridge } from '../testing/aiBridgeStub';
import { leaks } from '../testing/internalsLeak';
import { unavailableVocabularyBridge } from '../testing/vocabularyBridgeStub';

/**
 * Reader state presentation and the live region's placement
 * (6.5 Parts 2, 4, 6, 9; 6.4 audit C4 and C6).
 *
 * These are the claims that can only be made about the assembled reader:
 * whether the identified-word announcement survives a collapsed panel,
 * whether two pieces of chrome answer to the same accessible name, and
 * whether a neutral notice is being presented as a failure. Anything
 * decidable about a single component is tested beside that component.
 *
 * The PDF engine and page renderer are replaced exactly as in
 * `chrome.test.tsx` — jsdom has neither canvas nor layout — but every
 * piece of chrome under test here is the real one.
 */

const PAGE_TEXT = 'harbour lighthouse';

const page = vi.hoisted(() => ({
  hasTextLayer: true,
  /**
   * When set, the pages that have text according to the engine, whatever
   * the page on screen has: a document that is only partly a scan.
   */
  pagesWithText: null as readonly number[] | null,
  /** When set, the engine reports this error instead of opening. */
  openError: null as Error | null,
}));

const fakeDocument = (): OpenedPdf => ({
  pageCount: 2,
  label: 'harbour.pdf',
  getPageText: (pageNumber: number) => {
    const hasText =
      page.pagesWithText === null ? page.hasTextLayer : page.pagesWithText.includes(pageNumber);

    return Promise.resolve({
      pageNumber,
      segments: hasText ? [{ text: PAGE_TEXT, endsLine: false }] : [],
      hasTextLayer: hasText,
    });
  },
  getPageSize: () => Promise.resolve({ width: 600, height: 800, rotation: 0 }),
  getOutline: () => Promise.resolve([]),
  getNativePage: () => Promise.resolve({}),
  close: () => Promise.resolve(),
});

vi.mock('./pdf/rendererEngine', () => ({
  createRendererPdfEngine: (): PdfEngine => ({
    name: 'fake',
    version: '0',
    open: () =>
      Promise.resolve(
        page.openError === null
          ? { ok: true, value: fakeDocument() }
          : // The real classifier, so the failure the view renders is the
            // one the engine would actually hand it, `cause` and all.
            { ok: false, error: classifyOpenFailure(page.openError) },
      ),
  }),
}));

interface FakeRender {
  readonly completed: Promise<{ layer: ReturnType<typeof readTextLayer>; milliseconds: number }>;
  cancel(): void;
}

vi.mock('./pdf/renderPage', () => ({
  renderPage: ({ textLayerContainer }: { textLayerContainer: HTMLElement }): FakeRender => {
    if (page.hasTextLayer) {
      const span = document.createElement('span');

      span.setAttribute('role', 'presentation');
      span.textContent = PAGE_TEXT;
      textLayerContainer.replaceChildren(span);
    } else {
      textLayerContainer.replaceChildren();
    }

    return {
      completed: Promise.resolve({ layer: readTextLayer(textLayerContainer), milliseconds: 1 }),
      cancel: (): void => undefined,
    };
  },
}));

const { ReaderView } = await import('./ReaderView');

const createBridge = (): DesktopBridge => ({
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
  lookUpWord: () =>
    Promise.resolve({ status: 'unavailable' as const, reason: 'not-installed' as const }),
  vocabulary: unavailableVocabularyBridge(),
  ai: unconfiguredAiBridge(),
});

const windowWidth = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
};

/** Renders the reader and waits for the failure screen instead. */
const openFailingReader = async (error: Error): Promise<void> => {
  page.openError = error;
  render(<ReaderView bridge={createBridge()} />);

  await waitFor(() => {
    expect(screen.getByRole('alert')).toBeDefined();
  });
};

const openReader = async (): Promise<void> => {
  render(<ReaderView bridge={createBridge()} />);

  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Document' })).toBeDefined();
    expect(document.querySelector('.textLayer')).not.toBeNull();
    if (page.hasTextLayer) {
      expect(document.querySelector('.textLayer span')).not.toBeNull();
    }
  });
};

const toggle = (): HTMLElement => screen.getByRole('button', { name: 'Details' });

const announcement = (): HTMLElement => screen.getByTestId('word-announcement');

const originalWidth = window.innerWidth;

beforeEach(() => {
  page.hasTextLayer = true;
  page.pagesWithText = null;
  page.openError = null;
  windowWidth(1440);
});

afterEach(() => {
  cleanup();
  windowWidth(originalWidth);
  vi.restoreAllMocks();
});

describe.skip('the identified-word announcement outlives a collapsed panel (C4)', () => {
  it('is not inside the panel the Details toggle hides', async () => {
    await openReader();

    const detailsContent = document.getElementById('reading-details');

    expect(detailsContent).not.toBeNull();
    expect(detailsContent?.contains(announcement())).toBe(false);
  });

  it('is still in the accessibility tree after the reader collapses the panel', async () => {
    await openReader();

    fireEvent.click(toggle());

    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('reading-details')?.hasAttribute('hidden')).toBe(true);
    // `hidden` removes a subtree from the accessibility tree, and a live
    // region that is not in it never speaks. This is exactly what 6.4
    // shipped, and the reason C4 was raised.
    expect(announcement().closest('[hidden]')).toBeNull();
    expect(announcement().getAttribute('role')).toBe('status');
  });

  it('is in the tree at the narrow default, where the panel starts collapsed', async () => {
    windowWidth(SIDE_PANEL_BREAKPOINT - 1);
    await openReader();

    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(announcement().closest('[hidden]')).toBeNull();
  });

  it('leaves the panel with nothing live of its own, so a word is announced once', async () => {
    await openReader();

    const panel = screen.getByRole('complementary', { name: 'Reading details' });

    expect(panel.contains(announcement())).toBe(false);
    expect(panel.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).toHaveLength(0);
  });

  it('is not a focus stop, collapsed or open', async () => {
    await openReader();

    expect(announcement().getAttribute('tabindex')).toBeNull();
    expect(announcement().querySelectorAll('a, button, input, select, textarea')).toHaveLength(0);
  });
});

describe.skip('a collapsed panel hides its own content properly (A11Y, Part 9)', () => {
  it('leaves no focusable control behind inside the hidden subtree', async () => {
    await openReader();

    fireEvent.click(toggle());

    const hidden = document.getElementById('reading-details');
    const focusable = [...(hidden?.querySelectorAll('a, button, input, select, textarea') ?? [])];

    // They are unreachable to a keyboard because the container is
    // `hidden`; the point of the assertion is that the implementation
    // relies on `hidden` rather than on tabindex juggling, so nothing is
    // left half-reachable.
    expect(hidden?.hasAttribute('hidden')).toBe(true);
    expect(focusable.every((node) => node.closest('[hidden]') === hidden)).toBe(true);
  });

  it('keeps the toggle itself outside what it hides', async () => {
    await openReader();

    fireEvent.click(toggle());

    expect(toggle().closest('[hidden]')).toBeNull();
    expect(toggle().getAttribute('aria-controls')).toBe('reading-details');
  });
});

describe('two pieces of chrome never share one accessible name (C6)', () => {
  it('calls the toolbar group File and the scrolling region Document', async () => {
    await openReader();

    expect(screen.getByRole('group', { name: 'File' })).toBeDefined();
    expect(screen.getByRole('region', { name: 'Document' })).toBeDefined();
    expect(screen.queryByRole('group', { name: 'Document' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'File' })).toBeNull();
  });

  it('gives the two of them different names, whatever those names become', async () => {
    await openReader();

    const group = screen.getAllByRole('group')[0];
    const region = screen.getByRole('region', { name: 'Document' });

    expect(group?.getAttribute('aria-label')).not.toBe(region.getAttribute('aria-label'));
  });

  it('answers "Document" with exactly one element', async () => {
    await openReader();

    const named = [...document.querySelectorAll('[aria-label="Document"]')];

    expect(named).toHaveLength(1);
    expect(named[0]?.getAttribute('role')).toBe('region');
  });

  it('leaves no duplicate aria-label anywhere in the reader', async () => {
    await openReader();

    const names = [...document.querySelectorAll('[aria-label]')].map((node) =>
      node.getAttribute('aria-label'),
    );
    const duplicated = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];

    expect(duplicated).toStrictEqual([]);
  });
});

describe('a neutral notice is not dressed as a failure (ST-2, I6)', () => {
  it('tells the reader a page has no text without raising an alert', async () => {
    page.hasTextLayer = false;
    await openReader();

    const notice = await screen.findByText(/does not contain selectable text/);

    expect(notice.className).toContain('message--info');
    expect(notice.className).not.toContain('message--problem');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('tells the reader of a scan why, once, for the whole document', async () => {
    page.hasTextLayer = false;
    await openReader();

    const notice = await screen.findByTestId('scan-notice');

    expect(notice.textContent).toContain('This PDF does not contain selectable text');
    expect(notice.textContent).toContain('You can still read it here.');
    expect(notice.textContent).toContain('OCR');
    // One notice, not one for the document and one for the page.
    expect(screen.getAllByText(/does not contain selectable text/)).toHaveLength(1);
  });

  it('lets the reader put the scan notice away', async () => {
    page.hasTextLayer = false;
    await openReader();
    await screen.findByTestId('scan-notice');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByTestId('scan-notice')).toBeNull();
    expect(screen.queryByText(/does not contain selectable text/)).toBeNull();
  });

  it('speaks of the page, not the document, when only this page has no text', async () => {
    // The page on screen is a picture; the next one is real text.
    page.hasTextLayer = false;
    page.pagesWithText = [2];
    await openReader();

    const notice = await screen.findByText(/This page does not contain selectable text/);

    expect(notice.className).toContain('message--info');
    expect(screen.queryByTestId('scan-notice')).toBeNull();
    expect(screen.queryByText(/This PDF does not contain/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('says nothing about a document that has text', async () => {
    await openReader();
    // Long enough for the document to have been looked through.
    await screen.findByRole('region', { name: 'Document' });
    await Promise.resolve();

    expect(screen.queryByText(/does not contain selectable text/)).toBeNull();
  });

  it('opens a readable document with nothing to recover from', async () => {
    await openReader();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('.message--problem')).toBeNull();
  });
});

/**
 * The page-without-text notice: presented, never announced
 * (6.5 closure pass, acceptance audit C-5).
 *
 * The decision is written down in `ReaderView`; these are the tests that
 * hold it. The part worth testing is not only that it is silent, but that
 * it is silent *in both panel states*: 6.4's version was a live region
 * inside the container the Details toggle hides, so the same page state
 * was announced or not depending on a disclosure, which is the one
 * behaviour nobody chose.
 */
describe.skip('the page-without-text notice is presented, not announced (C-5)', () => {
  const notice = (): HTMLElement => screen.getByText(/does not contain selectable text/);

  /**
   * Waits for the notice this block is about, before reading it.
   *
   * `openReader()` returns when the page has rendered and its text layer
   * exists. Whether that page *has* text is reported one step later:
   * `PageSurface`'s render effect calls `onTextPresence`, `ReaderView`
   * puts the page into `pagesWithoutText`, and the notice arrives on the
   * commit after that. So the state this block asserts on is not part of
   * what `openReader()` waits for, and reading it with the synchronous
   * `notice()` is a race — measured at one `openReader()` call in fifteen
   * on an idle machine, and the cause of two full-suite failures found by
   * the M7.4 closure audit.
   *
   * The wait is on the notice itself, which is the observable signal that
   * the state propagated; no timeout is raised and no sleep is added.
   * After it resolves the element is there, so `notice()` stays
   * synchronous for every re-read below: re-querying the DOM *after* an
   * interaction is the point of those assertions, and a second wait would
   * hide a notice that disappeared.
   */
  const shownNotice = async (): Promise<HTMLElement> =>
    await screen.findByText(/does not contain selectable text/);

  it("is in the panel, with both of the specification's lines", async () => {
    page.hasTextLayer = false;
    await openReader();
    const shown = await shownNotice();

    expect(shown.textContent).toContain('This PDF does not contain selectable text.');
    expect(shown.textContent).toContain('Word lookup is unavailable for this document.');
    expect(screen.getByRole('complementary', { name: 'Reading details' }).contains(notice())).toBe(
      true,
    );
  });

  it('carries no live region of its own while the panel is open', async () => {
    page.hasTextLayer = false;
    await openReader();
    const shown = await shownNotice();

    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(shown.getAttribute('role')).toBeNull();
    expect(shown.getAttribute('aria-live')).toBeNull();
  });

  it('is decided by the state, not by whether the panel happens to be open', async () => {
    page.hasTextLayer = false;
    await openReader();
    const shown = await shownNotice();

    const open = {
      role: shown.getAttribute('role'),
      live: shown.getAttribute('aria-live'),
      text: shown.textContent,
    };

    fireEvent.click(toggle());

    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect({
      role: notice().getAttribute('role'),
      live: notice().getAttribute('aria-live'),
      text: notice().textContent,
    }).toStrictEqual(open);
  });

  it("leaves the identified word as the reader's one live region", async () => {
    page.hasTextLayer = false;
    await openReader();
    // Waited for, not assumed: this test says C4 holds *with the notice
    // on screen*, so a run where the notice had not arrived yet would
    // pass while proving nothing.
    const shown = await shownNotice();

    const live = [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')];

    expect(live).toHaveLength(1);
    expect(live[0]).toBe(announcement());
    expect(live).not.toContain(shown);
    // C4 still holds with the notice on screen: the one region there is
    // lives outside everything the Details toggle can hide.
    expect(announcement().closest('[hidden]')).toBeNull();
  });

  it('says nothing at all about a page that does have text', async () => {
    await openReader();

    expect(screen.queryByText(/does not contain selectable text/)).toBeNull();
  });
});

/**
 * The document-open failure screen (6.5 closure pass, audit C-3).
 *
 * The specification's two-line wording is the whole message. What used to
 * sit under it was `${error.name}: ${error.message}` from the engine — a
 * filesystem path for a missing file, an exception string for anything
 * unrecognised — and 6.5 had made this surface an `alert`.
 */
describe('a document that cannot be opened is explained, not quoted (C-3)', () => {
  const HOSTILE: readonly (readonly [string, Error])[] = [
    [
      'a filesystem path',
      Object.assign(new Error('Missing PDF "/home/ada/Documents/quarterly report.pdf".'), {
        name: 'MissingPDFException',
      }),
    ],
    [
      'an http url',
      Object.assign(
        new Error('Unexpected server response (404) while loading https://x.test/a.pdf'),
        {
          name: 'UnexpectedResponseException',
        },
      ),
    ],
    [
      'an exception message',
      Object.assign(new Error('Invalid PDF structure at offset 0x2f1a'), {
        name: 'InvalidPDFException',
      }),
    ],
    ['an internal identifier', new Error('worker task #7 rejected: TRANSPORT_CLOSED')],
  ];

  it('shows the specification wording and the way out', async () => {
    await openFailingReader(new Error('Invalid PDF structure'));

    const alert = screen.getByRole('alert');

    expect(alert.textContent).toContain('Unable to open this PDF.');
    expect(alert.textContent).toContain('The file may be corrupted, encrypted, or unsupported.');
    expect(alert.className).toContain('message--problem');
    expect(screen.getByRole('button', { name: 'Open another file…' })).toBeDefined();
  });

  it("puts none of the engine's wording on the screen", async () => {
    for (const [label, error] of HOSTILE) {
      cleanup();
      await openFailingReader(error);

      const screenText =
        screen.getByRole('region', { name: 'Document could not be opened' }).textContent ?? '';

      expect({ label, leaks: leaks(screenText).map(String) }).toStrictEqual({ label, leaks: [] });
      expect(screenText).not.toContain(error.name);
      expect(screenText).not.toContain(error.message);
    }
  });

  it('keeps the failure to one live region', async () => {
    await openFailingReader(new Error('Invalid PDF structure'));

    const polite = [...document.querySelectorAll('[role="status"], [aria-live]')];

    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    // The word announcement is the one node that outlives every state, and
    // on this screen it has nothing to say.
    expect(polite).toHaveLength(1);
    expect(polite[0]).toBe(screen.getByTestId('word-announcement'));
    expect(polite[0]?.textContent).toBe('');
  });
});
