// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { EMPTY_READER_STATE_SNAPSHOT } from '@shared/ipc/contracts';
import type {
  AppInfo,
  DesktopBridge,
  DocumentRequestResult,
  ReaderStateSnapshot,
} from '@shared/ipc/contracts';

import { App } from './App';
import { unconfiguredAiBridge } from '../testing/aiBridgeStub';
import { unavailableVocabularyBridge } from '../testing/vocabularyBridgeStub';

const noDocument = (): Promise<DocumentRequestResult> => Promise.resolve({ status: 'none' });

/** A bridge whose document operations do nothing, for shell level tests. */
const emptyState = (): Promise<ReaderStateSnapshot> => Promise.resolve(EMPTY_READER_STATE_SNAPSHOT);

const bridgeWith = (getAppInfo: DesktopBridge['getAppInfo']): DesktopBridge => ({
  getAppInfo,
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

const appInfo: AppInfo = {
  name: 'Lexleaf',
  version: '0.1.0',
  electronVersion: '41.10.7',
  chromeVersion: '142.0.0.0',
};

afterEach(() => {
  cleanup();
});

describe('App', () => {
  it('always shows the product shell, without a heading that repeats the window title', () => {
    render(<App bridge={null} />);

    // 0.2.3: the window's title bar names the application; the row that
    // repeated it is gone and its controls sit in the one bar.
    expect(screen.queryByRole('heading', { name: 'Lexleaf' })).toBeNull();
    expect(screen.getByTestId('library-toggle')).toBeDefined();
    expect(screen.getByTestId('settings-toggle')).toBeDefined();
    expect(screen.getByTestId('reading-mode-toggle')).toBeDefined();
  });

  it('shows runtime details supplied by the desktop bridge', async () => {
    const bridge = bridgeWith((): Promise<AppInfo> => Promise.resolve(appInfo));

    render(<App bridge={bridge} />);

    fireEvent.click(screen.getByTestId('settings-toggle'));

    expect(await screen.findByText('0.1.0')).toBeDefined();
    expect(screen.getByText('41.10.7')).toBeDefined();
  });

  it('explains the situation instead of failing when the bridge is missing', async () => {
    render(<App bridge={null} />);

    fireEvent.click(screen.getByTestId('settings-toggle'));

    expect(await screen.findByRole('alert')).toBeDefined();
    // 6.5: a failure is an `alert`, not a polite `status` (ST-2).
    expect(screen.getByRole('alert').textContent).toContain('unavailable');
  });

  it('shows the library without taking the reader apart', () => {
    const bridge = bridgeWith((): Promise<AppInfo> => Promise.resolve(appInfo));

    render(<App bridge={bridge} />);

    const surface = screen.getByTestId('reader-surface');

    expect(surface.hasAttribute('hidden')).toBe(false);
    expect(screen.queryByTestId('library')).toBeNull();

    fireEvent.click(screen.getByTestId('library-toggle'));

    // 0.2.3: the word list opens beside the book. The reading surface is
    // neither unmounted nor hidden, so a word can be read against its page.
    expect(screen.getByTestId('library')).toBeDefined();
    expect(screen.getByTestId('side-panel').contains(screen.getByTestId('library'))).toBe(true);
    expect(screen.getByTestId('reader-surface').hasAttribute('hidden')).toBe(false);
    expect(screen.getByTestId('reader-surface')).toBe(surface);

    fireEvent.click(screen.getByTestId('library-toggle'));

    expect(screen.queryByTestId('library')).toBeNull();
    expect(screen.getByTestId('reader-surface')).toBe(surface);
    expect(surface.hasAttribute('hidden')).toBe(false);
  });

  it('opens the library even with no document open', () => {
    render(<App bridge={null} />);

    fireEvent.click(screen.getByTestId('library-toggle'));

    expect(screen.getByTestId('library')).toBeDefined();
  });

  it('explains the situation when the main process cannot answer', async () => {
    const bridge = bridgeWith((): Promise<AppInfo> =>
      Promise.reject(new Error('IPC request failed')),
    );

    render(<App bridge={bridge} />);

    fireEvent.click(screen.getByTestId('settings-toggle'));

    // 6.5: a failure is an `alert` (ST-2).
    // 6.5 closure: and what it says comes from the failure, not from the
    // rejection — this used to print `IPC request failed` at the reader
    // and, once it became an alert, read it out (acceptance audit, C-3).
    const alert = await screen.findByRole('alert');

    expect(alert.textContent).toBe(
      'Application details are unavailable. The main process did not answer.',
    );
    expect(alert.textContent).not.toContain('IPC request failed');
  });
});
