// @vitest-environment jsdom
import { DEFAULT_PREFERENCES, type Preferences } from '@core/persistence/preferences';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_READER_STATE_SNAPSHOT } from '@shared/ipc/contracts';
import type { DesktopBridge, DocumentRequestResult, StateWriteHealth } from '@shared/ipc/contracts';

import { App } from './App';
import { unconfiguredAiBridge } from '../testing/aiBridgeStub';
import { unavailableVocabularyBridge } from '../testing/vocabularyBridgeStub';

/**
 * The settings surface inside the shell (ADR-031, 6.8).
 *
 * These are the integration properties the panel's own tests cannot see:
 * how it is reached, what happens to the reading surface while it is
 * open, that a change reaches the document attributes and the main
 * process, and that the library and the settings do not both occupy the
 * screen.
 */

const noDocument = (): Promise<DocumentRequestResult> => Promise.resolve({ status: 'none' });

const bridge = (
  preferences: Partial<Preferences> = {},
  savePreferences = vi.fn(() => Promise.resolve<StateWriteHealth>('ok')),
): DesktopBridge => ({
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
  getReaderState: () =>
    Promise.resolve({
      ...EMPTY_READER_STATE_SNAPSHOT,
      preferences: { ...DEFAULT_PREFERENCES, ...preferences },
    }),
  saveReadingPosition: () => Promise.resolve('ok' as const),
  forgetDocument: () => Promise.resolve('ok' as const),
  savePreferences,
  lookUpWord: () =>
    Promise.resolve({ status: 'unavailable' as const, reason: 'not-installed' as const }),
  vocabulary: unavailableVocabularyBridge(),
  ai: unconfiguredAiBridge(),
});

const settingsToggle = (): HTMLElement => screen.getByTestId('settings-toggle');

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-motion');
});

describe('reaching the settings', () => {
  it('is closed when the application starts', () => {
    render(<App bridge={bridge()} />);

    expect(screen.queryByTestId('settings')).toBeNull();
    expect(settingsToggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('opens and closes from one toggle with a fixed name', () => {
    render(<App bridge={bridge()} />);

    expect(screen.getByRole('button', { name: 'Settings' })).toBe(settingsToggle());

    fireEvent.click(settingsToggle());
    expect(screen.getByTestId('settings')).toBeTruthy();
    expect(settingsToggle().getAttribute('aria-pressed')).toBe('true');
    // The name does not change with the state (6.4's rule, WCAG 2.5.3).
    expect(screen.getByRole('button', { name: 'Settings' })).toBe(settingsToggle());

    fireEvent.click(settingsToggle());
    expect(screen.queryByTestId('settings')).toBeNull();
    expect(settingsToggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('comes back to reading from inside the panel', () => {
    render(<App bridge={bridge()} />);

    fireEvent.click(settingsToggle());
    fireEvent.click(screen.getByTestId('settings-close'));

    expect(screen.queryByTestId('settings')).toBeNull();
    expect(screen.getByTestId('reader-surface').hasAttribute('hidden')).toBe(false);
  });

  it('opens beside the reading surface, which stays mounted and visible', () => {
    render(<App bridge={bridge()} />);

    const surface = screen.getByTestId('reader-surface');

    fireEvent.click(settingsToggle());

    // 0.2.3: settings open in the side panel, so a change of appearance
    // or page colour can be seen on the book while it is being made.
    expect(screen.getByTestId('reader-surface')).toBe(surface);
    expect(surface.hasAttribute('hidden')).toBe(false);
    expect(screen.getByTestId('side-panel').contains(screen.getByTestId('settings'))).toBe(true);
  });

  it('shows the settings or the library, never both', () => {
    render(<App bridge={bridge()} />);

    fireEvent.click(settingsToggle());
    fireEvent.click(screen.getByTestId('library-toggle'));

    expect(screen.queryByTestId('settings')).toBeNull();
    expect(screen.getByTestId('library')).toBeTruthy();

    fireEvent.click(settingsToggle());

    expect(screen.getByTestId('settings')).toBeTruthy();
    expect(screen.queryByTestId('library')).toBeNull();
  });

  it('still offers the skip link while the settings are open', () => {
    // The document is beside the settings now, not behind them (A11Y-10).
    render(<App bridge={bridge()} />);

    expect(screen.getByTestId('skip-to-document')).toBeTruthy();

    fireEvent.click(settingsToggle());

    expect(screen.getByTestId('skip-to-document')).toBeTruthy();
  });
});

describe('changing a preference from the shell', () => {
  it('shows the stored value when the panel is opened', async () => {
    render(<App bridge={bridge({ appearance: 'dark', defaultZoomMode: 'fit-page' })} />);

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    fireEvent.click(settingsToggle());

    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Dark/u }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Fit page/u }).checked).toBe(true);
  });

  it('applies the appearance to the document and stores it', async () => {
    const savePreferences = vi.fn(() => Promise.resolve('ok' as const));

    render(<App bridge={bridge({}, savePreferences)} />);
    fireEvent.click(settingsToggle());
    fireEvent.click(screen.getByRole('radio', { name: /Light/u }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    await waitFor(() => {
      expect(savePreferences).toHaveBeenCalledWith({
        ...DEFAULT_PREFERENCES,
        appearance: 'light',
      });
    });
  });

  it('applies reduced motion immediately, with no reload', () => {
    render(<App bridge={bridge()} />);
    fireEvent.click(settingsToggle());
    fireEvent.click(screen.getByRole('radio', { name: /Always reduce motion/u }));

    expect(document.documentElement.getAttribute('data-motion')).toBe('reduced');
  });

  it('keeps the panel open and the choice visible after a change', () => {
    render(<App bridge={bridge()} />);
    fireEvent.click(settingsToggle());
    fireEvent.click(screen.getByRole('radio', { name: /Dark/u }));

    expect(screen.getByTestId('settings')).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Dark/u }).checked).toBe(true);
  });

  it('remembers the choice across a trip to the library and back', () => {
    render(<App bridge={bridge()} />);
    fireEvent.click(settingsToggle());
    fireEvent.click(screen.getByRole('radio', { name: /Dark/u }));

    fireEvent.click(screen.getByTestId('library-toggle'));
    fireEvent.click(settingsToggle());

    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Dark/u }).checked).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('survives a settings write that fails', async () => {
    const savePreferences = vi.fn(() => Promise.reject(new Error('disk full')));

    render(<App bridge={bridge({}, savePreferences)} />);
    fireEvent.click(settingsToggle());
    fireEvent.click(screen.getByRole('radio', { name: /Dark/u }));

    await waitFor(() => {
      expect(savePreferences).toHaveBeenCalled();
    });

    expect(screen.getByTestId('settings')).toBeTruthy();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('works when the preferences cannot be read at all', () => {
    const failing = {
      ...bridge(),
      getReaderState: () => Promise.reject(new Error('unreadable')),
    } as DesktopBridge;

    render(<App bridge={failing} />);
    fireEvent.click(settingsToggle());

    const checked = screen
      .getAllByRole('radio')
      .filter((radio): radio is HTMLInputElement => (radio as HTMLInputElement).checked);

    expect(checked.map((radio) => radio.value)).toStrictEqual([
      'system',
      'system',
      'fit-width',
      'original',
    ]);
  });
});
