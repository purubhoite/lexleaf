// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES } from '@core/persistence/preferences';
import { EMPTY_READER_STATE_SNAPSHOT } from '@shared/ipc/contracts';
import type { DesktopBridge, DocumentRequestResult, StateWriteHealth } from '@shared/ipc/contracts';

import { App } from './App';
import { PERSISTENCE_FAILURE_MESSAGE } from './usePersistenceNotice';
import { unconfiguredAiBridge } from '../testing/aiBridgeStub';
import { unavailableVocabularyBridge } from '../testing/vocabularyBridgeStub';

/**
 * What the reader is told when reading state stops reaching the disk
 * (M7.2, ADR-034, M7 investigation R6), through the real application
 * rather than through the hook that counts.
 *
 * The behaviour being pinned has four parts, and R6 is the absence of all
 * four: the reader is told, reading is not interrupted, they are told
 * once, and nothing pretends the write succeeded.
 */

const noDocument = (): Promise<DocumentRequestResult> => Promise.resolve({ status: 'none' });

interface Harness {
  readonly bridge: DesktopBridge;
  /** What the next write answers. */
  health: StateWriteHealth;
  readonly saves: number[];
}

const harness = (initial: StateWriteHealth): Harness => {
  const state: Harness = {
    health: initial,
    saves: [],
    bridge: {
      getAppInfo: () =>
        Promise.resolve({ name: 'test', version: '0', electronVersion: '0', chromeVersion: '0' }),
      openDocumentDialog: noDocument,
      getInitialDocument: noDocument,
      openRecentDocument: noDocument,
      getReaderState: () => Promise.resolve(EMPTY_READER_STATE_SNAPSHOT),
      saveReadingPosition: () => {
        state.saves.push(state.saves.length);

        return Promise.resolve(state.health);
      },
      forgetDocument: () => Promise.resolve(state.health),
      savePreferences: () => {
        state.saves.push(state.saves.length);

        return Promise.resolve(state.health);
      },
      lookUpWord: () =>
        Promise.resolve({ status: 'unavailable' as const, reason: 'not-installed' as const }),
      vocabulary: unavailableVocabularyBridge(),
      ai: unconfiguredAiBridge(),
    },
  };

  return state;
};

const notice = (): HTMLElement | null => screen.queryByTestId('persistence-notice');

/** Opens settings, chooses one appearance, closes settings. */
const changeAppearance = (value: 'system' | 'light' | 'dark'): void => {
  fireEvent.click(screen.getByTestId('settings-toggle'));

  const group = screen.getByTestId('setting-appearance');
  const radio = group.querySelector(`input[value="${value}"]`);

  if (radio === null) {
    throw new Error(`no appearance radio for ${value}`);
  }

  fireEvent.click(radio);
  fireEvent.click(screen.getByTestId('settings-close'));
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a reading state that cannot be saved', () => {
  it('says nothing at all while writes are reaching the disk', async () => {
    const { bridge } = harness('ok');

    render(<App bridge={bridge} />);
    changeAppearance('dark');

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    expect(notice()).toBeNull();
  });

  it('tells the reader once a write has failed', async () => {
    const { bridge } = harness('failing');

    render(<App bridge={bridge} />);
    changeAppearance('dark');

    const shown = await screen.findByTestId('persistence-notice');

    expect(shown.textContent).toContain(PERSISTENCE_FAILURE_MESSAGE);
  });

  it('does not interrupt reading: the document surface stays exactly where it was', async () => {
    const { bridge } = harness('failing');

    render(<App bridge={bridge} />);

    const surface = screen.getByTestId('reader-surface');

    changeAppearance('dark');
    await screen.findByTestId('persistence-notice');

    // The same node, still in the document, still not hidden: the notice
    // is chrome, not a screen the reader has to get out of.
    expect(screen.getByTestId('reader-surface')).toBe(surface);
    expect(surface.hasAttribute('hidden')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('applies the preference the reader chose even though it was not stored', async () => {
    const { bridge } = harness('failing');

    render(<App bridge={bridge} />);
    changeAppearance('dark');

    await screen.findByTestId('persistence-notice');

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('shows one notice however many writes fail afterwards', async () => {
    const state = harness('failing');

    render(<App bridge={state.bridge} />);
    changeAppearance('dark');
    await screen.findByTestId('persistence-notice');

    changeAppearance('light');
    changeAppearance('system');

    await waitFor(() => {
      expect(state.saves.length).toBeGreaterThanOrEqual(3);
    });

    expect(screen.getAllByTestId('persistence-notice')).toHaveLength(1);
  });

  it('is dismissible, and does not come back when the next write fails', async () => {
    const state = harness('failing');

    render(<App bridge={state.bridge} />);
    changeAppearance('dark');
    await screen.findByTestId('persistence-notice');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(notice()).toBeNull();

    changeAppearance('light');

    await waitFor(() => {
      expect(state.saves.length).toBeGreaterThanOrEqual(2);
    });

    expect(notice()).toBeNull();
  });

  it('is announced as a problem, once, and is not a second live region', async () => {
    const { bridge } = harness('failing');

    render(<App bridge={bridge} />);
    changeAppearance('dark');

    const shown = await screen.findByTestId('persistence-notice');

    // 6.5's ST-2 rule: a failure is an `alert`, and there is exactly one
    // node carrying this message.
    expect(shown.getAttribute('role')).toBe('alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(shown.className).toContain('message--problem');
  });

  it('does not claim the write succeeded, and does not explain the machine', async () => {
    const { bridge } = harness('failing');

    render(<App bridge={bridge} />);
    changeAppearance('dark');

    const text = (await screen.findByTestId('persistence-notice')).textContent ?? '';

    for (const forbidden of ['ENOENT', 'EACCES', 'EISDIR', 'errno', '.json', '/', '\\']) {
      expect({ forbidden, text }).toStrictEqual({
        forbidden,
        text: expect.not.stringContaining(forbidden) as string,
      });
    }

    // The point of the sentence: it reports that saving is *not*
    // happening. Nothing in it may read as a confirmation.
    expect(text).toContain('cannot be saved');
    for (const claim of ['has been saved', 'was saved', 'will be saved', 'Saved']) {
      expect({ claim, text }).toStrictEqual({
        claim,
        text: expect.not.stringContaining(claim) as string,
      });
    }
  });

  it('starts from the defaults it was given, so the test above is not vacuous', () => {
    const { bridge } = harness('ok');

    render(<App bridge={bridge} />);

    expect(DEFAULT_PREFERENCES.appearance).toBe('system');
    expect(notice()).toBeNull();
  });
});
