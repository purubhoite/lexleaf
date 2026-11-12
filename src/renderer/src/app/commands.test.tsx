// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_READER_STATE_SNAPSHOT } from '@shared/ipc/contracts';
import type {
  DesktopBridge,
  DocumentRequestResult,
  ReaderStateSnapshot,
} from '@shared/ipc/contracts';
import type { MenuCommand } from '@shared/ipc/menuCommands';

import { App } from './App';
import { unconfiguredAiBridge } from '../testing/aiBridgeStub';
import { unavailableVocabularyBridge } from '../testing/vocabularyBridgeStub';

/*
 * The menu, the keyboard and reading mode (0.2.3).
 *
 * A command is the same thing whichever way it arrives. These check that
 * the menu's commands and the keyboard's reach the window, that each does
 * what the button in the bar does, and that reading mode can always be
 * left.
 */

const noDocument = (): Promise<DocumentRequestResult> => Promise.resolve({ status: 'none' });

const emptyState = (): Promise<ReaderStateSnapshot> => Promise.resolve(EMPTY_READER_STATE_SNAPSHOT);

interface Harness {
  readonly bridge: DesktopBridge;
  readonly openDocumentDialog: ReturnType<typeof vi.fn<() => Promise<DocumentRequestResult>>>;
  readonly setFullScreen: ReturnType<typeof vi.fn<(on: boolean) => Promise<void>>>;
  readonly stopListening: ReturnType<typeof vi.fn<() => void>>;
  readonly menu: (command: MenuCommand) => void;
}

const harness = (): Harness => {
  const openDocumentDialog = vi.fn<() => Promise<DocumentRequestResult>>(noDocument);
  const setFullScreen = vi.fn<(on: boolean) => Promise<void>>(() => Promise.resolve());
  const stopListening = vi.fn<() => void>();
  let listener: ((command: MenuCommand) => void) | null = null;

  const bridge: DesktopBridge = {
    getAppInfo: () =>
      Promise.resolve({
        name: 'Lexleaf',
        version: '0.2.3',
        electronVersion: '41.10.7',
        chromeVersion: '142.0.0.0',
      }),
    openDocumentDialog,
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
    onMenuCommand: (next) => {
      listener = next;

      return stopListening;
    },
    setFullScreen,
  };

  return {
    bridge,
    openDocumentDialog,
    setFullScreen,
    stopListening,
    menu: (command) => {
      act(() => {
        listener?.(command);
      });
    },
  };
};

afterEach(() => {
  cleanup();
});

describe('commands from the application menu', () => {
  it('opens and closes the saved words, as the button does', () => {
    const { bridge, menu } = harness();

    render(<App bridge={bridge} />);

    menu('toggle-saved-words');

    expect(screen.getByTestId('library')).toBeDefined();
    expect(screen.getByTestId('library-toggle').getAttribute('aria-pressed')).toBe('true');

    menu('toggle-saved-words');

    expect(screen.queryByTestId('library')).toBeNull();
  });

  it('opens the settings, and About leads to the same place', () => {
    const { bridge, menu } = harness();

    render(<App bridge={bridge} />);

    menu('about');

    expect(screen.getByTestId('settings')).toBeDefined();
    expect(screen.getByTestId('about')).toBeDefined();

    // About is a destination, not a toggle: choosing it again leaves it open.
    menu('about');

    expect(screen.getByTestId('settings')).toBeDefined();

    menu('toggle-settings');

    expect(screen.queryByTestId('settings')).toBeNull();
  });

  it('asks for a document when Open is chosen', () => {
    const { bridge, menu, openDocumentDialog } = harness();

    render(<App bridge={bridge} />);
    menu('open-document');

    expect(openDocumentDialog).toHaveBeenCalledTimes(1);
  });

  it('does nothing, and does not fail, for a document command with no document', () => {
    const { bridge, menu } = harness();

    render(<App bridge={bridge} />);

    for (const command of ['close-document', 'find', 'go-to-page', 'toggle-contents'] as const) {
      menu(command);
    }

    expect(screen.getByRole('region', { name: 'Start reading' })).toBeDefined();
  });

  it('stops listening when the window goes away', () => {
    const { bridge, stopListening } = harness();

    render(<App bridge={bridge} />);
    cleanup();

    expect(stopListening).toHaveBeenCalled();
  });
});

describe('commands from the keyboard', () => {
  it('opens a document on Ctrl+O and the saved words on Ctrl+L', () => {
    const { bridge, openDocumentDialog } = harness();

    render(<App bridge={bridge} />);

    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });

    expect(openDocumentDialog).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'l', ctrlKey: true });

    expect(screen.getByTestId('library')).toBeDefined();
  });

  it('opens the settings on Ctrl+comma', () => {
    const { bridge } = harness();

    render(<App bridge={bridge} />);
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });

    expect(screen.getByTestId('settings')).toBeDefined();
  });

  it('leaves a plain letter alone, so typing is never a command', () => {
    const { bridge, openDocumentDialog } = harness();

    render(<App bridge={bridge} />);
    fireEvent.keyDown(window, { key: 'o' });
    fireEvent.keyDown(window, { key: 'l' });

    expect(openDocumentDialog).not.toHaveBeenCalled();
    expect(screen.queryByTestId('library')).toBeNull();
  });
});

describe('reading mode', () => {
  it('puts the bar and any panel away and asks for the whole screen', () => {
    const { bridge, setFullScreen } = harness();

    render(<App bridge={bridge} />);
    fireEvent.click(screen.getByTestId('library-toggle'));
    fireEvent.click(screen.getByTestId('reading-mode-toggle'));

    expect(setFullScreen).toHaveBeenLastCalledWith(true);
    expect(document.querySelector('.reader__bar')).toBeNull();
    expect(screen.queryByTestId('library')).toBeNull();
    expect(screen.getByTestId('exit-reading-mode')).toBeDefined();
  });

  it('is left with Escape', () => {
    const { bridge, setFullScreen } = harness();

    render(<App bridge={bridge} />);
    fireEvent.keyDown(window, { key: 'F11' });

    expect(screen.getByTestId('exit-reading-mode')).toBeDefined();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(setFullScreen).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId('exit-reading-mode')).toBeNull();
    expect(document.querySelector('.reader__bar')).not.toBeNull();
  });

  it('is left with its own button, and with F11 again', () => {
    const { bridge, menu } = harness();

    render(<App bridge={bridge} />);
    menu('toggle-reading-mode');
    fireEvent.click(screen.getByTestId('exit-reading-mode'));

    expect(screen.queryByTestId('exit-reading-mode')).toBeNull();

    fireEvent.keyDown(window, { key: 'F11' });
    fireEvent.keyDown(window, { key: 'F11' });

    expect(screen.queryByTestId('exit-reading-mode')).toBeNull();
  });

  it('still works in a window that cannot go full screen', () => {
    const { bridge } = harness();
    const withoutFullScreen: { -readonly [Key in keyof DesktopBridge]: DesktopBridge[Key] } = {
      ...bridge,
    };

    delete withoutFullScreen.setFullScreen;

    render(<App bridge={withoutFullScreen} />);
    fireEvent.click(screen.getByTestId('reading-mode-toggle'));

    expect(screen.getByTestId('exit-reading-mode')).toBeDefined();
  });
});

describe('a file held over the window', () => {
  const drag = (type: string, types: readonly string[]): void => {
    const event = new Event(type, { bubbles: true });

    Object.defineProperty(event, 'dataTransfer', { value: { types } });
    act(() => {
      window.dispatchEvent(event);
    });
  };

  it('is told it can be dropped, until it is dropped or taken away', () => {
    const { bridge } = harness();

    render(<App bridge={bridge} />);

    expect(screen.queryByTestId('drop-target')).toBeNull();

    drag('dragenter', ['Files']);

    expect(screen.getByTestId('drop-target').textContent).toBe('Drop the file to open it');

    drag('dragleave', ['Files']);

    expect(screen.queryByTestId('drop-target')).toBeNull();

    drag('dragenter', ['Files']);
    drag('drop', ['Files']);

    expect(screen.queryByTestId('drop-target')).toBeNull();
  });

  it('says nothing about a drag that carries no file', () => {
    const { bridge } = harness();

    render(<App bridge={bridge} />);
    drag('dragenter', ['text/plain']);

    expect(screen.queryByTestId('drop-target')).toBeNull();
  });
});
