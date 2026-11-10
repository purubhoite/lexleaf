/**
 * @vitest-environment jsdom
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenedPdf } from '@core/pdf/pdfEngine';

import { createPageRegistry } from './interaction/pageRegistry';
import { leaks } from '../testing/internalsLeak';

/**
 * What a reader is told when one page of an open document cannot be drawn
 * (6.6 Part 0B).
 *
 * A page render fails inside the engine, so the failure arrives as whatever
 * exception the engine threw: `MissingPDFException` quotes a file path,
 * decoder faults quote internal names, and a rejected fetch quotes a URL.
 * Until 6.6 that text was printed straight onto the page overlay. These
 * tests drive the real component through the real failing render branch —
 * the engine is replaced, the component is not — and assert on what the
 * overlay actually shows.
 *
 * They are deliberately not written as "the overlay equals this sentence".
 * Hostile engine text is injected and the rendered output is searched for
 * it, and for the whole `internalsLeak` battery, so a future message that
 * interpolated something else would still be caught.
 */

interface RenderOutcome {
  /** Thrown by the fake `renderPage`. */
  renderError: unknown;
  /** Thrown by the fake page lookup, before any rendering is attempted. */
  nativePageError: unknown;
}

const engine = vi.hoisted(() => {
  const outcome: RenderOutcome = { renderError: null, nativePageError: null };

  /**
   * Fails the way an engine fails. The reason is deliberately `unknown`:
   * part of what is being tested is that a page failure which is not an
   * `Error` is handled like any other.
   */
  const reject = (reason: unknown): Promise<never> =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above.
    Promise.reject(reason);

  return { outcome, reject };
});

vi.mock('./pdf/renderPage', () => ({
  renderPage: (): { completed: Promise<never>; cancel: () => void } => ({
    completed: engine.reject(engine.outcome.renderError),
    cancel: (): void => undefined,
  }),
}));

const { PageSurface } = await import('./PageSurface');

const fakeDocument = (): OpenedPdf => ({
  pageCount: 3,
  label: 'harbour.pdf',
  getPageText: (pageNumber: number) =>
    Promise.resolve({ pageNumber, segments: [], hasTextLayer: false }),
  getPageSize: () => Promise.resolve({ width: 600, height: 800, rotation: 0 }),
  getNativePage: (): Promise<object> =>
    engine.outcome.nativePageError === null
      ? Promise.resolve({})
      : engine.reject(engine.outcome.nativePageError),
  close: () => Promise.resolve(),
});

/** Renders page 7 of a document whose rendering fails, and returns the alert. */
const failingPage = async (): Promise<HTMLElement> => {
  render(
    <PageSurface
      document={fakeDocument()}
      documentId="doc-1"
      pageNumber={7}
      scale={1}
      top={0}
      width={600}
      height={800}
      registry={createPageRegistry()}
      spans={[]}
      showTextLayer={false}
      onRendered={() => undefined}
      onTextPresence={() => undefined}
    />,
  );

  await waitFor(() => {
    expect(screen.getByRole('alert')).toBeDefined();
  });

  return screen.getByRole('alert');
};

/**
 * Engine failures that carry something a reader must never be shown. Each
 * is thrown by the real render path, not handed to the component as text.
 */
const HOSTILE_FAILURES: readonly (readonly [string, unknown])[] = [
  [
    'a POSIX path',
    new Error("ENOENT: no such file or directory, open '/home/reader/Documents/salary.pdf'"),
  ],
  ['a Windows path', new Error('Cannot read page: C:\\Users\\reader\\AppData\\cache\\pdf.bin')],
  ['a URL', new Error('Failed to fetch https://cdn.example.test/v2/pages/7?token=abc123')],
  [
    'exception text with a stack frame',
    new Error(
      'UnknownErrorException: Invalid XRef stream\n    at parseXRef (pdf.worker.js:4411:19)',
    ),
  ],
  ['an internal identifier', new Error('decoder JBIG2 generic region sym=0x7f objId=p7_r42')],
  ['a thrown non-error', { toString: () => 'SQLITE_CORRUPT: database disk image is malformed' }],
];

describe('a page that cannot be drawn', () => {
  beforeEach(() => {
    engine.outcome.renderError = new Error('render failed');
    engine.outcome.nativePageError = null;
  });

  afterEach(() => {
    cleanup();
  });

  it.each(HOSTILE_FAILURES)('does not show the reader %s', async (_label, failure) => {
    engine.outcome.renderError = failure;

    const alert = await failingPage();
    const shown = alert.textContent ?? '';
    const engineText = failure instanceof Error ? failure.message : String(failure);

    // Nothing the engine said, in whole or in part: the longest word of the
    // engine's text would be enough to leak a path segment or a host name.
    const engineWords = engineText
      .split(/[\s,:;()]+/u)
      .filter((word) => word.length > 6)
      .map((word) => word.toLowerCase());

    expect({
      shown,
      quotedEngineText: engineText.length > 0 && shown.includes(engineText),
      quotedEngineWords: engineWords.filter((word) => shown.toLowerCase().includes(word)),
      leaked: leaks(shown).map(String),
    }).toStrictEqual({ shown, quotedEngineText: false, quotedEngineWords: [], leaked: [] });
  });

  it('still tells the reader which page it is', async () => {
    engine.outcome.renderError = new Error("ENOENT: open '/var/tmp/harbour.pdf'");

    const alert = await failingPage();

    // The page number is the one piece of the failure a reader can act on.
    expect(alert.textContent).toContain('7');
    expect(alert.textContent).toMatch(/could not be displayed/i);
  });

  it('keeps the failure presented as a problem overlay on the page', async () => {
    const alert = await failingPage();

    expect(alert.className).toBe('page__overlay page__overlay--problem');
    expect(alert.closest('.page')).not.toBeNull();
    expect(alert.closest('.page')?.getAttribute('aria-label')).toBe('Page 7');
    // The page's own furniture is untouched by the failure.
    expect(document.querySelector('.page__canvas')).not.toBeNull();
    expect(document.querySelector('.page__text.textLayer')).not.toBeNull();
  });

  it('reports a page that could not be fetched from the engine the same way', async () => {
    engine.outcome.nativePageError = new Error(
      "MissingPDFException: Missing PDF '/home/reader/Documents/salary.pdf'",
    );

    const alert = await failingPage();

    expect(alert.textContent).toContain('7');
    expect(leaks(alert.textContent ?? '')).toStrictEqual([]);
  });

  it('shows the plain placeholder, not a problem, while the page is still loading', () => {
    engine.outcome.renderError = new Error('never settles');
    render(
      <PageSurface
        document={fakeDocument()}
        documentId="doc-1"
        pageNumber={7}
        scale={1}
        top={0}
        width={600}
        height={800}
        registry={createPageRegistry()}
        spans={[]}
        showTextLayer={false}
        onRendered={() => undefined}
        onTextPresence={() => undefined}
      />,
    );

    const overlay = document.querySelector('.page__overlay');

    expect(overlay?.className).toBe('page__overlay');
    expect(overlay?.getAttribute('role')).toBeNull();
  });
});
