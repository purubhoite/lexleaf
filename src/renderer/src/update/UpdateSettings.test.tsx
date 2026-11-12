// @vitest-environment jsdom
import { DEFAULT_PREFERENCES } from '@core/persistence/preferences';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_READER_STATE_SNAPSHOT } from '@shared/ipc/contracts';
import type { DesktopBridge, DocumentRequestResult } from '@shared/ipc/contracts';
import type { UpdateBridge, UpdateIpcState } from '@shared/ipc/updateContracts';

import { App } from '../app/App';
import { unconfiguredAiBridge } from '../testing/aiBridgeStub';
import { unavailableVocabularyBridge } from '../testing/vocabularyBridgeStub';

/**
 * The update notice and its settings group, through the application shell:
 * what a reader sees at startup, what the controls do, and what
 * reaches the bridge.
 */

const noDocument = (): Promise<DocumentRequestResult> => Promise.resolve({ status: 'none' });

const IDLE: UpdateIpcState = { automatic: true, outcome: { status: 'idle' } };
const AVAILABLE: UpdateIpcState = {
  automatic: true,
  outcome: { status: 'available', version: '0.2.0', canInstall: false },
};
const INSTALLABLE: UpdateIpcState = {
  automatic: true,
  outcome: { status: 'available', version: '0.2.0', canInstall: true },
};
const READY: UpdateIpcState = { automatic: true, outcome: { status: 'ready', version: '0.2.0' } };
const DOWNLOAD_FAILED: UpdateIpcState = {
  automatic: true,
  outcome: { status: 'download-failed', version: '0.2.0' },
};
const CURRENT: UpdateIpcState = { automatic: true, outcome: { status: 'up-to-date' } };
const FAILED: UpdateIpcState = { automatic: true, outcome: { status: 'failed' } };

const updateBridge = (
  startup: UpdateIpcState,
  manual: UpdateIpcState | Error = startup,
  downloaded: UpdateIpcState | Error | Promise<UpdateIpcState> = READY,
): UpdateBridge => ({
  check: vi.fn((isManual: boolean) =>
    !isManual
      ? Promise.resolve(startup)
      : manual instanceof Error
        ? Promise.reject(manual)
        : Promise.resolve(manual),
  ),
  setAutomatic: vi.fn((automatic: boolean) =>
    Promise.resolve<UpdateIpcState>({ automatic, outcome: startup.outcome }),
  ),
  download: vi.fn(() =>
    downloaded instanceof Error ? Promise.reject(downloaded) : Promise.resolve(downloaded),
  ),
  install: vi.fn(() => Promise.resolve()),
  openDownload: vi.fn(() => Promise.resolve()),
});

const bridge = (updates?: UpdateBridge): DesktopBridge => ({
  getAppInfo: () =>
    Promise.resolve({
      name: 'Lexleaf',
      version: '0.1.1',
      electronVersion: '41.10.7',
      chromeVersion: '142.0.0.0',
    }),
  openDocumentDialog: noDocument,
  getInitialDocument: noDocument,
  openRecentDocument: noDocument,
  getReaderState: () =>
    Promise.resolve({ ...EMPTY_READER_STATE_SNAPSHOT, preferences: DEFAULT_PREFERENCES }),
  saveReadingPosition: () => Promise.resolve('ok' as const),
  forgetDocument: () => Promise.resolve('ok' as const),
  savePreferences: () => Promise.resolve('ok' as const),
  lookUpWord: () =>
    Promise.resolve({ status: 'unavailable' as const, reason: 'not-installed' as const }),
  vocabulary: unavailableVocabularyBridge(),
  ai: unconfiguredAiBridge(),
  ...(updates === undefined ? {} : { updates }),
});

const openSettings = async (): Promise<void> => {
  fireEvent.click(screen.getByTestId('settings-toggle'));
  await screen.findByTestId('settings');
};

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-motion');
});

describe('the update notice in the shell', () => {
  it('asks once at startup, and not as a manual check', async () => {
    const updates = updateBridge(IDLE);

    render(<App bridge={bridge(updates)} />);

    await waitFor(() => {
      expect(updates.check).toHaveBeenCalledExactlyOnceWith(false);
    });
    expect(screen.queryByTestId('update-notice')).toBeNull();
  });

  it('says a newer version is available and opens its page when asked', async () => {
    const updates = updateBridge(AVAILABLE);

    render(<App bridge={bridge(updates)} />);

    const notice = await screen.findByTestId('update-notice');

    expect(notice.textContent).toContain('Lexleaf 0.2.0 is available.');
    expect(notice.getAttribute('role')).toBe('status');

    fireEvent.click(screen.getByRole('button', { name: 'Open the download page' }));

    expect(updates.openDownload).toHaveBeenCalledExactlyOnceWith();
  });

  it('goes away when dismissed and stays away', async () => {
    render(<App bridge={bridge(updateBridge(AVAILABLE))} />);

    await screen.findByTestId('update-notice');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByTestId('update-notice')).toBeNull();
  });

  it('says nothing when the build is current or the startup check failed', async () => {
    for (const state of [CURRENT, FAILED]) {
      const updates = updateBridge(state);

      render(<App bridge={bridge(updates)} />);

      await waitFor(() => {
        expect(updates.check).toHaveBeenCalled();
      });
      expect(screen.queryByTestId('update-notice')).toBeNull();
      cleanup();
    }
  });

  it('survives a startup check that rejects', async () => {
    const updates: UpdateBridge = {
      ...updateBridge(IDLE),
      check: vi.fn(() => Promise.reject(new Error('bridge failure'))),
    };

    render(<App bridge={bridge(updates)} />);

    await waitFor(() => {
      expect(updates.check).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('update-notice')).toBeNull();
    expect(screen.getByTestId('settings-toggle')).toBeTruthy();
  });
});

describe('updating from inside the application', () => {
  it('offers the download instead of the page where Lexleaf can install it', async () => {
    const updates = updateBridge(INSTALLABLE);

    render(<App bridge={bridge(updates)} />);

    const notice = await screen.findByTestId('update-notice');

    expect(notice.textContent).toContain('Lexleaf 0.2.0 is available.');
    expect(screen.getByRole('button', { name: 'Download update' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open the download page' })).toBeNull();
    expect(updates.download).not.toHaveBeenCalled();
    expect(updates.install).not.toHaveBeenCalled();
  });

  it('downloads when asked, says so meanwhile, and installs nothing by itself', async () => {
    let finish: (state: UpdateIpcState) => void = () => {};
    const pending = new Promise<UpdateIpcState>((resolve) => {
      finish = resolve;
    });
    const updates = updateBridge(INSTALLABLE, INSTALLABLE, pending);

    render(<App bridge={bridge(updates)} />);

    await screen.findByTestId('update-notice');
    fireEvent.click(screen.getByRole('button', { name: 'Download update' }));

    expect(updates.download).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByTestId('update-notice').textContent).toContain('Downloading Lexleaf 0.2.0');
    expect(screen.queryByRole('button', { name: 'Download update' })).toBeNull();

    finish(READY);

    await screen.findByRole('button', { name: 'Restart and install' });
    expect(screen.getByTestId('update-notice').textContent).toContain(
      'Lexleaf 0.2.0 is ready to install. Lexleaf will close and reopen.',
    );
    expect(updates.install).not.toHaveBeenCalled();
  });

  it('installs only when the reader presses the button', async () => {
    const updates = updateBridge(READY);

    render(<App bridge={bridge(updates)} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Restart and install' }));

    expect(updates.install).toHaveBeenCalledExactlyOnceWith();
  });

  it('lets the reader put the restart off, and brings the notice back from settings', async () => {
    const updates = updateBridge(READY, READY);

    render(<App bridge={bridge(updates)} />);

    await screen.findByTestId('update-notice');
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));

    expect(screen.queryByTestId('update-notice')).toBeNull();
    expect(updates.install).not.toHaveBeenCalled();

    await openSettings();

    expect(screen.getByTestId('update-status').textContent).toContain('is ready to install');
    expect(screen.getByRole('button', { name: 'Restart and install' })).toBeTruthy();
  });

  it.each([
    ['the download fails', DOWNLOAD_FAILED],
    ['the bridge rejects', new Error('bridge failure')],
  ])('says so when %s, and offers another try and the page', async (_name, downloaded) => {
    const updates = updateBridge(INSTALLABLE, INSTALLABLE, downloaded);

    render(<App bridge={bridge(updates)} />);

    await screen.findByTestId('update-notice');
    fireEvent.click(screen.getByRole('button', { name: 'Download update' }));

    await screen.findByRole('button', { name: 'Try again' });

    const notice = screen.getByTestId('update-notice');

    expect(notice.textContent).toContain('Lexleaf 0.2.0 could not be downloaded.');
    expect(notice.getAttribute('role')).toBe('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Open the download page' }));
    expect(updates.openDownload).toHaveBeenCalledExactlyOnceWith();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(updates.download).toHaveBeenCalledTimes(2);
  });
});

describe('the update group in settings', () => {
  it('is absent from a build with no update bridge', async () => {
    render(<App bridge={bridge()} />);
    await openSettings();

    expect(screen.queryByTestId('setting-updates')).toBeNull();
  });

  it('shows the automatic check as on by default and explains what it does', async () => {
    render(<App bridge={bridge(updateBridge(IDLE))} />);
    await openSettings();

    const group = screen.getByTestId('setting-updates');

    expect((screen.getByLabelText(/^Check automatically/u) as HTMLInputElement).checked).toBe(true);
    expect(group.textContent).toContain('at most once a day');
    expect(group.textContent).toContain('Nothing is downloaded or installed until you ask');
    expect(screen.queryByTestId('update-status')).toBeNull();
  });

  it('shows the stored choice when the reader had turned it off', async () => {
    render(
      <App bridge={bridge(updateBridge({ automatic: false, outcome: { status: 'idle' } }))} />,
    );
    await openSettings();

    await waitFor(() => {
      expect(
        (screen.getByLabelText(/^Never check automatically/u) as HTMLInputElement).checked,
      ).toBe(true);
    });
  });

  it('stores the choice when it is changed', async () => {
    const updates = updateBridge(IDLE);

    render(<App bridge={bridge(updates)} />);
    await openSettings();

    fireEvent.click(screen.getByLabelText(/^Never check automatically/u));

    expect(updates.setAutomatic).toHaveBeenCalledExactlyOnceWith(false);
    await waitFor(() => {
      expect(
        (screen.getByLabelText(/^Never check automatically/u) as HTMLInputElement).checked,
      ).toBe(true);
    });
  });

  it('checks when the button is pressed and reports that the build is current', async () => {
    const updates = updateBridge(IDLE, CURRENT);

    render(<App bridge={bridge(updates)} />);
    await openSettings();

    fireEvent.click(screen.getByTestId('update-check-now'));

    expect(updates.check).toHaveBeenLastCalledWith(true);
    expect((await screen.findByTestId('update-status')).textContent).toBe(
      'You have the latest version.',
    );
  });

  it('reports a newer version, and brings a dismissed notice back', async () => {
    const updates = updateBridge(AVAILABLE, AVAILABLE);

    render(<App bridge={bridge(updates)} />);

    await screen.findByTestId('update-notice');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await openSettings();

    fireEvent.click(screen.getByTestId('update-check-now'));

    await screen.findByTestId('update-notice');
    expect(screen.getByTestId('update-status').textContent).toContain(
      'Lexleaf 0.2.0 is available.',
    );
  });

  it.each([
    ['the check fails', FAILED],
    ['the bridge rejects', new Error('bridge failure')],
  ])('says so as a problem when %s', async (_name, manual) => {
    render(<App bridge={bridge(updateBridge(IDLE, manual))} />);
    await openSettings();

    fireEvent.click(screen.getByTestId('update-check-now'));

    const status = await screen.findByTestId('update-status');

    expect(status.textContent).toContain('could not check for updates');
    expect(status.getAttribute('role')).toBe('alert');
    expect((screen.getByTestId('update-check-now') as HTMLButtonElement).disabled).toBe(false);
  });
});
