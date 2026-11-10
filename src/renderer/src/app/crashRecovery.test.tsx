// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES } from '@core/persistence/preferences';
import { EMPTY_READER_STATE_SNAPSHOT } from '@shared/ipc/contracts';
import type {
  DesktopBridge,
  DocumentRequestResult,
  ReaderStateSnapshot,
  SessionRecovery,
} from '@shared/ipc/contracts';

import { App } from './App';
import { RECOVERY_NOTICE_MESSAGE } from './useSessionRecovery';
import { unconfiguredAiBridge } from '../testing/aiBridgeStub';
import { unavailableVocabularyBridge } from '../testing/vocabularyBridgeStub';

/**
 * What the reader sees in a renderer that replaced a dead one (M7.1,
 * ADR-035, M7 investigation R1), and what that renderer does about the
 * document it is supposed to be showing.
 *
 * The state-restoration tests here assert the *committed* state only.
 * Nothing in M7.1 makes a write durable, so a test that asserted the
 * position at the instant of the crash would be asserting a guarantee
 * the product does not offer; 7.3 owns that.
 */

const noDocument = (): Promise<DocumentRequestResult> => Promise.resolve({ status: 'none' });

interface Options {
  readonly sessionRecovery?: SessionRecovery;
  readonly snapshot?: Partial<ReaderStateSnapshot>;
  readonly openRecentDocument?: () => Promise<DocumentRequestResult>;
}

const bridgeFor = ({
  sessionRecovery = 'none',
  snapshot = {},
  openRecentDocument = noDocument,
}: Options = {}): DesktopBridge => ({
  getAppInfo: () =>
    Promise.resolve({ name: 't', version: '0', electronVersion: '0', chromeVersion: '0' }),
  openDocumentDialog: noDocument,
  getInitialDocument: noDocument,
  openRecentDocument,
  getReaderState: () =>
    Promise.resolve({
      ...EMPTY_READER_STATE_SNAPSHOT,
      preferences: DEFAULT_PREFERENCES,
      sessionRecovery,
      ...snapshot,
    }),
  saveReadingPosition: () => Promise.resolve('ok' as const),
  forgetDocument: () => Promise.resolve('ok' as const),
  savePreferences: () => Promise.resolve('ok' as const),
  lookUpWord: () =>
    Promise.resolve({ status: 'unavailable' as const, reason: 'not-installed' as const }),
  vocabulary: unavailableVocabularyBridge(),
  ai: unconfiguredAiBridge(),
});

const startSurface = (): Element | null =>
  document.querySelector('section[aria-label="Start reading"]');

afterEach(cleanup);

describe('a renderer that replaced one that died', () => {
  it('tells the reader, once', async () => {
    render(<App bridge={bridgeFor({ sessionRecovery: 'after-crash' })} />);

    const notice = await screen.findByTestId('recovery-notice');

    expect(notice.textContent).toContain(RECOVERY_NOTICE_MESSAGE);
    expect(screen.getAllByTestId('recovery-notice')).toHaveLength(1);
  });

  it('announces it as a problem, through the existing Message', async () => {
    render(<App bridge={bridgeFor({ sessionRecovery: 'after-crash' })} />);

    const notice = await screen.findByTestId('recovery-notice');

    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.className).toContain('message--problem');
  });

  it('is dismissible, and stays dismissed', async () => {
    render(<App bridge={bridgeFor({ sessionRecovery: 'after-crash' })} />);

    const notice = await screen.findByTestId('recovery-notice');
    const dismiss = notice.querySelector('button');

    expect(dismiss?.tagName).toBe('BUTTON');
    fireEvent.click(dismiss as HTMLButtonElement);

    await waitFor(() => expect(screen.queryByTestId('recovery-notice')).toBeNull());

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByTestId('recovery-notice')).toBeNull();
  });

  it('does not interrupt reading: the reader surface is still there', async () => {
    render(<App bridge={bridgeFor({ sessionRecovery: 'after-crash' })} />);

    await screen.findByTestId('recovery-notice');

    expect(screen.getByTestId('reader-surface')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle')).toBeTruthy();
  });

  it('says nothing about a process, an exit code or a path', async () => {
    render(<App bridge={bridgeFor({ sessionRecovery: 'after-crash' })} />);

    const notice = await screen.findByTestId('recovery-notice');
    const text = notice.textContent ?? '';

    for (const forbidden of ['crash', 'exit', 'renderer', 'process', 'SIGSEGV', '/', '\\']) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('does not over-promise: it says "as far as it had been saved"', () => {
    expect(RECOVERY_NOTICE_MESSAGE).toContain('as far as it had been saved');
    expect(RECOVERY_NOTICE_MESSAGE).not.toMatch(/everything (was|has been) saved/iu);
  });
});

describe('an ordinary session', () => {
  it('says nothing at all', async () => {
    render(<App bridge={bridgeFor({ sessionRecovery: 'none' })} />);

    await waitFor(() => expect(startSurface()).not.toBeNull());
    expect(screen.queryByTestId('recovery-notice')).toBeNull();
  });

  it('says nothing when the bridge is missing entirely', async () => {
    render(<App bridge={null} />);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByTestId('recovery-notice')).toBeNull();
  });

  it('says nothing when the state snapshot cannot be read', async () => {
    const bridge = bridgeFor();
    const failing: DesktopBridge = {
      ...bridge,
      getReaderState: () => Promise.reject(new Error('no state')),
    };

    render(<App bridge={failing} />);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.queryByTestId('recovery-notice')).toBeNull();
  });
});

describe('what the recovered renderer does about the document', () => {
  it('reopens the last committed document through the existing state service', async () => {
    const openRecentDocument = vi.fn(noDocument);

    render(
      <App
        bridge={bridgeFor({
          sessionRecovery: 'after-crash',
          snapshot: { lastDocumentId: 'committed-document' },
          openRecentDocument,
        })}
      />,
    );

    await waitFor(() => expect(openRecentDocument).toHaveBeenCalledTimes(1));
    // By id, through the channel that already existed. No crash-only
    // snapshot, no path, and nothing new was persisted to make this work.
    expect(openRecentDocument).toHaveBeenCalledWith('committed-document');
  });

  it('returns to a usable start surface when there is no committed document', async () => {
    const openRecentDocument = vi.fn(noDocument);

    render(
      <App
        bridge={bridgeFor({
          sessionRecovery: 'after-crash',
          snapshot: { lastDocumentId: null },
          openRecentDocument,
        })}
      />,
    );

    await waitFor(() => expect(startSurface()).not.toBeNull());
    expect(openRecentDocument).not.toHaveBeenCalled();
    expect(screen.getByTestId('recovery-notice')).toBeTruthy();
  });

  it('stays on the start surface when the committed document has since gone', async () => {
    render(
      <App
        bridge={bridgeFor({
          sessionRecovery: 'after-crash',
          snapshot: { lastDocumentId: 'vanished' },
          openRecentDocument: () =>
            Promise.resolve({ status: 'unreadable', reason: 'missing', name: 'Gone.pdf' }),
        })}
      />,
    );

    await waitFor(() => expect(startSurface()).not.toBeNull());
    // The restore is still a silent one (M7.2, R3): a document nobody
    // asked for in this session does not become a failure screen.
    expect(document.querySelector('section[aria-label="Document could not be opened"]')).toBeNull();
  });
});
