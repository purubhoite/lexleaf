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
 * Application shell (Milestone 6.4, Parts 1 and 3).
 *
 * The library toggle used to rename itself every time it was pressed:
 * "Saved words" became "Back to reading", so to anything consuming the
 * accessibility tree the control's identity changed rather than its state.
 * A toggle button has one name and a pressed state; that is what these
 * tests hold it to, including the part that is easy to get wrong when
 * fixing it — an `aria-label` that disagrees with the visible text, which
 * trades one failure (an unstable name) for another (WCAG 2.5.3).
 *
 * The header itself is checked for the property CTL-10 actually needs: it
 * stays one row, and the controls in it are still the same controls.
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

const toggle = (): HTMLElement => screen.getByTestId('library-toggle');

afterEach(() => {
  cleanup();
});

describe('the library toggle keeps one name (6.4, Part 3)', () => {
  it('is findable by the same name in both states', () => {
    render(<App bridge={bridge()} />);

    expect(screen.getByRole('button', { name: 'Saved words' })).toBe(toggle());

    fireEvent.click(toggle());

    // Pressed, and still the same control by name. Before 6.4 this
    // query returned nothing once the library was open.
    expect(screen.getByRole('button', { name: 'Saved words' })).toBe(toggle());
  });

  it('carries the state in aria-pressed, where a toggle carries it', () => {
    render(<App bridge={bridge()} />);

    expect(toggle().getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('says out loud what it says on screen (WCAG 2.5.3)', () => {
    render(<App bridge={bridge()} />);

    // The stable name must be the visible one. An `aria-label` that
    // overrode changing visible text would pass the test above and still
    // leave a speech-input user asking for a label that is not there.
    expect(toggle().getAttribute('aria-label')).toBeNull();
    expect(toggle().getAttribute('aria-labelledby')).toBeNull();
    expect(toggle().textContent?.trim()).toBe('Saved words');
  });

  it('still switches between the two screens', () => {
    render(<App bridge={bridge()} />);

    expect(screen.getByTestId('reader-surface').hasAttribute('hidden')).toBe(false);
    expect(screen.queryByTestId('library')).toBeNull();

    fireEvent.click(toggle());

    expect(screen.getByTestId('reader-surface').hasAttribute('hidden')).toBe(true);
    expect(screen.getByTestId('library')).toBeDefined();
  });

  it('is not the only way back, which is what makes the stable name safe', () => {
    render(<App bridge={bridge()} />);

    fireEvent.click(toggle());

    const back = screen.getByRole('button', { name: 'Back to reading' });

    fireEvent.click(back);

    expect(screen.getByTestId('reader-surface').hasAttribute('hidden')).toBe(false);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });
});

describe('the shell header is one compact row (W16, CTL-10)', () => {
  it('holds the title and the chrome controls, and nothing else', () => {
    render(<App bridge={bridge()} />);

    const header = document.querySelector('.shell__header');

    expect(header).not.toBeNull();
    expect(header?.querySelector('h1')?.textContent).toBe('Lexleaf');
    expect(header?.contains(toggle())).toBe(true);
    expect(header?.contains(screen.getByText('About Lexleaf'))).toBe(true);
  });

  it('does not grow a second heading level in the chrome', () => {
    render(<App bridge={bridge()} />);

    // One document title. A second `h1` in the shell would make the
    // heading outline ambiguous for anyone navigating by headings.
    expect(document.querySelectorAll('h1')).toHaveLength(1);
  });

  it('keeps the about disclosure closed and native', () => {
    render(<App bridge={bridge()} />);

    const summary = screen.getByText('About Lexleaf');

    expect(summary.tagName).toBe('SUMMARY');
    expect(summary.closest('details')?.open).toBe(false);
  });
});
