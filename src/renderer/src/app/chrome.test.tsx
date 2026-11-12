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

  it('still opens and closes the saved words', () => {
    render(<App bridge={bridge()} />);

    expect(screen.getByTestId('reader-surface').hasAttribute('hidden')).toBe(false);
    expect(screen.queryByTestId('library')).toBeNull();

    fireEvent.click(toggle());

    // 0.2.3: beside the book, not instead of it.
    expect(screen.getByTestId('reader-surface').hasAttribute('hidden')).toBe(false);
    expect(screen.getByTestId('library')).toBeDefined();

    fireEvent.click(toggle());

    expect(screen.queryByTestId('library')).toBeNull();
  });

  it('is not the only way back, which is what makes the stable name safe', () => {
    render(<App bridge={bridge()} />);

    fireEvent.click(toggle());

    const back = screen.getByRole('button', { name: 'Close saved words' });

    fireEvent.click(back);

    expect(screen.queryByTestId('library')).toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });
});

describe('the window has one bar (0.2.3; W16, CTL-10)', () => {
  it('puts the application\u2019s controls in the reader\u2019s bar, not in a row of their own', () => {
    render(<App bridge={bridge()} />);

    expect(document.querySelector('.shell__header')).toBeNull();
    expect(document.querySelectorAll('.reader__bar')).toHaveLength(1);
    expect(document.querySelector('.reader__bar')?.contains(toggle())).toBe(true);
    expect(
      document.querySelector('.reader__bar')?.contains(screen.getByTestId('settings-toggle')),
    ).toBe(true);
  });

  it('does not spend a heading on the application\u2019s own name', () => {
    render(<App bridge={bridge()} />);

    // The title bar says "Lexleaf"; the window does not say it again.
    expect(document.querySelectorAll('h1')).toHaveLength(0);
  });

  it('keeps About out of the bar and in the settings', () => {
    render(<App bridge={bridge()} />);

    expect(screen.queryByText('About Lexleaf')).toBeNull();

    fireEvent.click(screen.getByTestId('settings-toggle'));

    expect(screen.getByTestId('about').contains(screen.getByText('About Lexleaf'))).toBe(true);
    expect(screen.getByTestId('settings').contains(screen.getByTestId('about'))).toBe(true);
  });
});
