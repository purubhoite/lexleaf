/**
 * @vitest-environment jsdom
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_READER_STATE_SNAPSHOT } from '@shared/ipc/contracts';
import type { AppInfo, DesktopBridge } from '@shared/ipc/contracts';

import { App } from '../app/App';
import { LibraryView } from '../library/LibraryView';
import type { LibraryControls, LibraryState } from '../library/useVocabularyLibrary';
import { RecentDocuments } from '../reader/RecentDocuments';
import { unconfiguredAiBridge } from '../testing/aiBridgeStub';
import { leaks } from '../testing/internalsLeak';
import { unavailableVocabularyBridge } from '../testing/vocabularyBridgeStub';

/**
 * Empty and failure states across the surfaces that have them
 * (6.5, Parts 6 and 7; investigation ST-4 … ST-8).
 *
 * The rule being tested is not "an empty state exists" — 6.4 already had
 * sentences in these places. It is that an empty state is a dead end
 * unless it says what to do next, that a failure keeps the action that
 * would recover from it, and that neither of them leaks a path, an
 * exception or a stack into the reader's view.
 */

const baseState: LibraryState = {
  status: 'ready',
  items: [],
  documents: [],
  sort: 'newest',
  documentId: null,
  query: '',
  hasMore: false,
  loadingMore: false,
  truncated: false,
  unreadable: 0,
  failure: null,
  undo: null,
  nonce: 0,
};

const controls = (state: Partial<LibraryState> = {}): LibraryControls => ({
  state: { ...baseState, ...state },
  setSort: vi.fn(),
  setDocument: vi.fn(),
  setQuery: vi.fn(),
  loadMore: vi.fn(),
  reload: vi.fn(),
  remove: vi.fn(),
  undoRemove: vi.fn(),
  dismissUndo: vi.fn(),
});

/**
 * A bridge whose only interesting behaviour is how `getAppInfo` fails.
 * Everything else answers emptily, as in `App.test.tsx`.
 */
const appInfoBridge = (getAppInfo: DesktopBridge['getAppInfo']): DesktopBridge => ({
  getAppInfo,
  openDocumentDialog: () => Promise.resolve({ status: 'none' as const }),
  getInitialDocument: () => Promise.resolve({ status: 'none' as const }),
  openRecentDocument: () => Promise.resolve({ status: 'none' as const }),
  getReaderState: () => Promise.resolve(EMPTY_READER_STATE_SNAPSHOT),
  saveReadingPosition: () => Promise.resolve('ok' as const),
  forgetDocument: () => Promise.resolve('ok' as const),
  savePreferences: () => Promise.resolve('ok' as const),
  lookUpWord: () =>
    Promise.resolve({ status: 'unavailable' as const, reason: 'not-installed' as const }),
  vocabulary: unavailableVocabularyBridge(),
  ai: unconfiguredAiBridge(),
});

/** Rejections shaped like the things that must never reach the window. */
const HOSTILE_REJECTIONS: readonly (readonly [string, Error])[] = [
  ['a filesystem path', new Error("ENOENT: no such file or directory, open '/home/ada/notes.pdf'")],
  ['an http url', new Error('request to https://api.example.com/v1/app-info failed')],
  [
    'an exception message',
    new TypeError("Cannot read properties of undefined (reading 'version')"),
  ],
  ['an internal identifier', new Error('IPC request failed: channel app:getAppInfo, handler #4')],
];

// A rejection that is not an `Error` needs no case of its own: the hook
// does not look at the rejection at all, and the state can only hold one
// of two failure codes, so there is nothing for it to carry.

const showLibrary = (state: Partial<LibraryState> = {}): void => {
  render(<LibraryView library={controls(state)} onOpenOrigin={vi.fn()} onClose={vi.fn()} />);
};

afterEach(() => {
  cleanup();
});

describe('an empty state says what to do next (ST-5)', () => {
  it('names the control that fills an empty recent-documents list', () => {
    render(<RecentDocuments recents={[]} onOpen={vi.fn()} onForget={vi.fn()} />);

    const empty = screen.getByText(/No documents have been opened yet/);

    expect(empty.textContent).toContain('Open PDF');
    expect(empty.className).toContain('message--empty');
  });

  it('does not announce an empty list, because nothing happened', () => {
    render(<RecentDocuments recents={[]} onOpen={vi.fn()} onForget={vi.fn()} />);

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says nothing of the sort once there is something to list', () => {
    render(
      <RecentDocuments
        recents={[
          {
            id: 'doc-1',
            name: 'harbour.pdf',
            sizeBytes: 2048,
            available: true,
            lastPage: 3,
            pageCount: 12,
            lastOpenedAt: '2026-01-01T00:00:00.000Z',
          },
        ]}
        onOpen={vi.fn()}
        onForget={vi.fn()}
      />,
    );

    expect(screen.queryByText(/No documents have been opened yet/)).toBeNull();
  });

  it('tells a reader with no saved words how a word gets saved', () => {
    showLibrary();

    const empty = screen.getByTestId('library-empty');

    expect(empty.textContent).toContain('Look a word up while reading');
    expect(empty.textContent).toContain('Save word');
    expect(empty.getAttribute('role')).toBeNull();
  });

  it('tells a reader whose search found nothing how to get back to the rest', () => {
    showLibrary({ query: 'quern' });

    const empty = screen.getByTestId('library-empty');

    // A search that matches nothing is the one empty state that can trap
    // a reader: the list looks deleted. It has to name the way back.
    expect(empty.textContent).toContain('Clear the search');
    expect(screen.getByLabelText(/Search/)).toBeDefined();
  });
});

describe('a failure keeps the way out (ST-6, ST-8)', () => {
  it('offers Try again beside a library that could not be read', () => {
    showLibrary({ status: 'failed', failure: { kind: 'unavailable', reason: 'corrupt' } });

    const failed = screen.getByTestId('library-failed');

    expect(failed.querySelector('button')?.textContent).toBe('Try again');
    expect(screen.getByRole('alert').textContent).toBeTruthy();
  });

  it('says what happened without quoting the exception', () => {
    for (const reason of [
      'not-writable',
      'locked',
      'schema-too-new',
      'corrupt',
      'not-a-database',
      'unknown',
    ] as const) {
      cleanup();
      showLibrary({ status: 'failed', failure: { kind: 'unavailable', reason } });

      const text = screen.getByTestId('library-failed').textContent ?? '';

      expect({ reason, leaks: leaks(text).map(String) }).toStrictEqual({ reason, leaks: [] });
      expect(text.length).toBeGreaterThan('Try again'.length);
    }
  });

  it('reports unreadable rows as a problem that has not destroyed anything', () => {
    showLibrary({ unreadable: 2 });

    const unreadable = screen.getByTestId('library-unreadable');

    expect(unreadable.textContent).toContain('Nothing has been deleted');
    expect(unreadable.getAttribute('role')).toBe('alert');
  });

  it('keeps a truncated list as news rather than as a failure', () => {
    showLibrary({ truncated: true });

    const truncated = screen.getByTestId('library-truncated');

    expect(truncated.getAttribute('role')).toBe('status');
    expect(truncated.className).toContain('message--info');
    expect(truncated.textContent).toContain('Narrow the search');
  });
});

describe('the busy state is a polite one (ST-1)', () => {
  it('announces loading without interrupting', () => {
    showLibrary({ status: 'loading' });

    const loading = screen.getByTestId('library-loading');

    expect(loading.getAttribute('role')).toBe('status');
    expect(loading.className).toContain('message--busy');
  });
});

describe('a failure never quotes the machine (6.5 closure, audit C-3)', () => {
  it('tells the reader the main process did not answer, and nothing else', async () => {
    render(
      <App
        bridge={appInfoBridge((): Promise<AppInfo> =>
          Promise.reject(new Error("ENOENT: no such file or directory, open '/home/ada/x.pdf'")),
        )}
      />,
    );

    const alert = await screen.findByRole('alert');

    expect(alert.textContent).toBe(
      'Application details are unavailable. The main process did not answer.',
    );
  });

  it('says the same sanitised thing whatever the rejection carried', async () => {
    for (const [label, rejection] of HOSTILE_REJECTIONS) {
      cleanup();
      render(<App bridge={appInfoBridge((): Promise<AppInfo> => Promise.reject(rejection))} />);

      const text = (await screen.findByRole('alert')).textContent ?? '';

      expect({ label, leaks: leaks(text).map(String) }).toStrictEqual({ label, leaks: [] });
      expect(text).toContain('The main process did not answer.');
    }
  });

  it('explains a missing bridge in its own words, still as a failure', async () => {
    render(<App bridge={null} />);

    const alert = await screen.findByRole('alert');

    expect(alert.textContent).toBe(
      'Application details are unavailable. The desktop bridge is unavailable.',
    );
    expect(leaks(alert.textContent ?? '')).toStrictEqual([]);
  });
});
