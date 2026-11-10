// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { EMPTY_READER_STATE_SNAPSHOT } from '@shared/ipc/contracts';
import type {
  DesktopBridge,
  DocumentRequestResult,
  ReaderStateSnapshot,
} from '@shared/ipc/contracts';

import { App } from './App';
import { unconfiguredAiBridge } from '../testing/aiBridgeStub';
import { unavailableVocabularyBridge } from '../testing/vocabularyBridgeStub';

/**
 * Accessibility baseline for the shell (Milestone 6.2).
 *
 * The shell is where focus order starts, so this is where the skip link
 * (A11Y-10) and the landmark names (A11Y-15) are proved. The disclosure
 * controls are checked for the thing that is easy to break while styling
 * them: a `<summary>` that stops behaving like one.
 */

const noDocument = (): Promise<DocumentRequestResult> => Promise.resolve({ status: 'none' });

const emptyState = (): Promise<ReaderStateSnapshot> => Promise.resolve(EMPTY_READER_STATE_SNAPSHOT);

const bridge = (): DesktopBridge => ({
  getAppInfo: () =>
    Promise.resolve({
      name: 'Lexleaf',
      version: '0.1.0',
      electronVersion: '41.10.7',
      chromeVersion: '142.0.0.0',
    }),
  openDocumentDialog: noDocument,
  getInitialDocument: noDocument,
  openRecentDocument: noDocument,
  getReaderState: emptyState,
  saveReadingPosition: () => Promise.resolve('ok' as const),
  forgetDocument: () => Promise.resolve('ok' as const),
  savePreferences: () => Promise.resolve('ok' as const),
  lookUpWord: () =>
    Promise.resolve({ status: 'unavailable' as const, reason: 'not-installed' as const }),
  vocabulary: unavailableVocabularyBridge(),
  ai: unconfiguredAiBridge(),
});

/** Everything the keyboard can reach, in document order. */
const focusables = (): HTMLElement[] =>
  [
    ...document.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => element.closest('[hidden]') === null);

afterEach(() => {
  cleanup();
});

describe('skip link (A11Y-10)', () => {
  it('is the first thing the keyboard reaches', () => {
    render(<App bridge={bridge()} />);

    const first = focusables()[0];

    expect(first).toBeDefined();
    expect(first?.textContent).toBe('Skip to document');
  });

  it('is a link, not a button dressed as one', () => {
    render(<App bridge={bridge()} />);

    expect(screen.getByRole('link', { name: 'Skip to document' })).toBeDefined();
  });

  it('moves focus to the document region', () => {
    render(<App bridge={bridge()} />);

    const scroller = screen.getByRole('region', { name: 'Document' });

    expect(document.activeElement).not.toBe(scroller);

    fireEvent.click(screen.getByTestId('skip-to-document'));

    expect(document.activeElement).toBe(scroller);
  });

  it('does not navigate the window when it is used', () => {
    render(<App bridge={bridge()} />);

    const before = window.location.href;
    const link = screen.getByTestId('skip-to-document');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });

    link.dispatchEvent(event);

    // A `file://` fragment navigation is not how focus should move.
    expect(event.defaultPrevented).toBe(true);
    expect(window.location.href).toBe(before);
  });

  it('is not offered while the library is covering the document', () => {
    render(<App bridge={bridge()} />);

    fireEvent.click(screen.getByTestId('library-toggle'));

    // The document surface is hidden in this state; a link into it would
    // send focus somewhere the reader cannot see.
    expect(screen.queryByTestId('skip-to-document')).toBeNull();
  });

  it('points at a target that actually exists', () => {
    render(<App bridge={bridge()} />);

    const href = screen.getByTestId('skip-to-document').getAttribute('href') ?? '';

    expect(href.startsWith('#')).toBe(true);
    expect(document.getElementById(href.slice(1))).not.toBeNull();
  });
});

describe('landmarks (A11Y-15)', () => {
  it('gives every section an accessible name', () => {
    render(<App bridge={bridge()} />);

    const unnamed = [...document.querySelectorAll('section')].filter(
      (section) =>
        (section.getAttribute('aria-label') ?? '').trim() === '' &&
        section.getAttribute('aria-labelledby') === null,
    );

    expect(unnamed.map((section) => section.className)).toEqual([]);
  });

  it('names the document region and the start screen', () => {
    render(<App bridge={bridge()} />);

    expect(screen.getByRole('region', { name: 'Document' })).toBeDefined();
    expect(screen.getByRole('region', { name: 'Start reading' })).toBeDefined();
  });
});

describe('disclosure controls (6.1 audit, finding 4)', () => {
  it('keeps the native summary element and its native open state', () => {
    render(<App bridge={bridge()} />);

    const summary = screen.getByText('About Lexleaf');
    const details = summary.closest('details');

    expect(summary.tagName).toBe('SUMMARY');
    expect(details?.open).toBe(false);
  });

  it('does not re-implement the disclosure with ARIA of its own', () => {
    render(<App bridge={bridge()} />);

    const summary = screen.getByText('About Lexleaf');

    // `<details>` already exposes expanded state to assistive technology.
    // A hand-written `aria-expanded` here would be a second source of
    // truth, free to drift from the element's real state.
    expect(summary.getAttribute('aria-expanded')).toBeNull();
    expect(summary.getAttribute('role')).toBeNull();
  });

  it('is reachable by Tab without a tabindex of its own', () => {
    render(<App bridge={bridge()} />);

    const summary = screen.getByText('About Lexleaf');

    expect(summary.getAttribute('tabindex')).toBeNull();
    expect(focusables()).toContain(summary);
  });
});
