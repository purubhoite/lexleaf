import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import type { SavedWord } from '@core/vocabulary/types';
import type { DesktopBridge } from '@shared/ipc/contracts';
import { keyboardCommand } from '@shared/ipc/menuCommands';
import type { VocabularyExportFormat, VocabularyExportOutcome } from '@core/vocabulary/export';

import { describeExportOutcome } from '../library/LibraryExport';
import { LibraryView } from '../library/LibraryView';
import { Icon } from '../ui/Icon';
import { SettingsPanel } from '../settings/SettingsPanel';
import { ReportProblem } from '../support/ReportProblem';
import { usePreferences } from '../settings/usePreferences';
import { Message } from '../ui/Message';
import { UpdateMessage } from '../update/UpdateMessage';
import { UpdateSettings } from '../update/UpdateSettings';
import { useUpdateCheck } from '../update/useUpdateCheck';
import { useVocabularyLibrary } from '../library/useVocabularyLibrary';
import { DOCUMENT_SCROLLER_ID, ReaderView } from '../reader/ReaderView';
import type {
  NavigationOutcome,
  OccurrenceTarget,
} from '../reader/vocabulary/useOccurrenceNavigation';

import { createCommandBus } from './commandBus';
import { APP_INFO_FAILURE_MESSAGES, useAppInfo } from './useAppInfo';
import { useFileDragOver } from './useFileDragOver';
import { PERSISTENCE_FAILURE_MESSAGE, usePersistenceNotice } from './usePersistenceNotice';
import { RECOVERY_NOTICE_MESSAGE, useSessionRecovery } from './useSessionRecovery';
import { VocabularyRecoveryPanel } from './VocabularyRecoveryPanel';

export interface AppProps {
  /** Bridge exposed by the preload script, or `null` when it is unavailable. */
  readonly bridge: DesktopBridge | null;
}

const RuntimeDetails = ({ bridge }: AppProps): ReactElement => {
  const state = useAppInfo(bridge);

  if (state.status === 'loading') {
    return <Message kind="busy">Reading application details…</Message>;
  }

  if (state.status === 'unavailable') {
    return (
      // 6.5: this is a failure, so it is an `alert` now rather than the
      // polite `status` it was given when the call site chose its own role.
      // 6.5 closure: the second sentence comes from a closed set keyed by
      // the failure, never from the error that caused it.
      <Message kind="problem">
        Application details are unavailable. {APP_INFO_FAILURE_MESSAGES[state.reason]}
      </Message>
    );
  }

  return (
    <div className="about-copy">
      <p>
        <strong>Lexleaf</strong> is a local-first PDF reader that helps you discover and save
        unfamiliar words while you read.
      </p>
      <p>
        Version <strong>{state.appInfo.version}</strong>
      </p>
      <p>
        Lexleaf application code is available under the Apache-2.0 licence. Third-party components
        and dictionary data retain their own licences.
      </p>
      <p>See the bundled third-party notices for component and dictionary licensing details.</p>
      <details>
        <summary>Technical information</summary>
        <dl className="details">
          <dt>Electron</dt>
          <dd>{state.appInfo.electronVersion}</dd>
          <dt>Chromium</dt>
          <dd>{state.appInfo.chromeVersion}</dd>
        </dl>
      </details>
    </div>
  );
};

const describeOutcome = (outcome: NavigationOutcome, target: OccurrenceTarget): string => {
  switch (outcome.kind) {
    case 'exact':
      return '';
    case 'approximate':
      return `${target.word} has moved on this page. The first match is highlighted.`;
    case 'not-on-page':
      return `${target.word} is no longer on page ${String(target.page)} of ${target.documentName}.`;
    default:
      return `${target.documentName} could not be opened. It may have been moved or renamed.`;
  }
};

/**
 * Application shell.
 *
 * It is deliberately thin: the reading surface owns the window, and the
 * build information sits in a disclosure rather than above the document,
 * because a reading application should give the page the space.
 *
 * The library is shown by **hiding** the reader, never by unmounting it.
 * Unmounting would throw away the open document, every rendered page and
 * the reader's place in it, and glancing at a word list is not a reason to
 * reload a book.
 */
export const App = ({ bridge }: AppProps): ReactElement => {
  const [showLibrary, setShowLibrary] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [target, setTarget] = useState<OccurrenceTarget | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [readingMode, setReadingMode] = useState(false);
  const bus = useMemo(() => createCommandBus(), []);
  const draggingFile = useFileDragOver();

  const library = useVocabularyLibrary({ bridge, active: showLibrary });
  /*
   * The one place the application says that reading state is not being
   * saved (M7.2, ADR-034). It lives here because every write in the
   * product reports through it — positions and forgotten documents from
   * the reader, the four settings from the panel — and "one notice per
   * session" is only true if one component is counting.
   */
  const persistence = usePersistenceNotice();
  const reportWriteHealth = persistence.report;
  /*
   * The other session-level notice, and the only thing the renderer is
   * told about a crash it did not survive (M7.1, ADR-035). It sits beside
   * the persistence one rather than inventing a place of its own: both
   * are facts about this session rather than about the document, and the
   * shell is where a fact about the session belongs.
   */
  const recovery = useSessionRecovery(bridge);
  /*
   * The third session-level notice: a newer release exists, is being
   * downloaded, or is ready to install. Like the two above it is the
   * shared `Message`, said once, and the reader closes it.
   */
  const updates = useUpdateCheck(bridge);
  const reportProblem = bridge?.reportProblem;
  /*
   * The one copy of the four preferences (ADR-031). It lives here because
   * two different places need it — the settings panel that changes it and
   * the reader that two of the four preferences describe — and a value two
   * components need is a value one parent should own.
   */
  const { preferences, set: setPreference } = usePreferences(bridge, reportWriteHealth);

  const openOrigin = useCallback(
    (item: SavedWord): void => {
      const vocabulary = bridge?.vocabulary ?? null;

      if (vocabulary === null) {
        return;
      }

      setMessage(null);

      // The occurrences are asked for again rather than taken from the
      // card: the card may have been rendered minutes ago, and the store
      // is the thing that knows where a word was met.
      void vocabulary.occurrences(item.id).then((reply) => {
        const place = reply.ok ? reply.value[0] : undefined;

        if (place === undefined) {
          setMessage(`There is no recorded place for ${item.word.display}.`);

          return;
        }

        setTarget({
          itemId: item.id,
          word: item.word.display,
          normalized: item.word.normalized,
          documentId: place.documentId,
          documentName: place.documentName,
          page: place.page,
          charStart: place.charStart,
          charEnd: place.charEnd,
          pageOffsetFraction: place.pageOffsetFraction,
        });
      });
    },
    [bridge],
  );

  const onOutcome = useCallback(
    (outcome: NavigationOutcome): void => {
      if (target === null) {
        return;
      }

      const text = describeOutcome(outcome, target);

      setMessage(text.length === 0 ? null : text);
    },
    [target],
  );

  const setFullScreen = bridge?.setFullScreen;

  const changeReadingMode = useCallback(
    (on: boolean): void => {
      setReadingMode(on);

      if (on) {
        setShowLibrary(false);
        setShowSettings(false);
      }

      void setFullScreen?.(on);
    },
    [setFullScreen],
  );

  const exportLibrary = bridge?.vocabulary.exportLibrary;

  const exportFromMenu = useCallback(
    (format: VocabularyExportFormat): void => {
      if (exportLibrary === undefined) {
        return;
      }

      void exportLibrary(format)
        .catch((): VocabularyExportOutcome => ({ status: 'failed' }))
        .then((outcome) => {
          setMessage(describeExportOutcome(outcome));
        });
    },
    [exportLibrary],
  );

  /* The shell's share of the commands; the reader answers the rest. */
  useEffect(
    () =>
      bus.subscribe((command) => {
        switch (command) {
          case 'toggle-saved-words':
            setReadingMode(false);
            setShowSettings(false);
            setShowLibrary((current) => !current);
            break;
          case 'toggle-settings':
            setReadingMode(false);
            setShowLibrary(false);
            setShowSettings((current) => !current);
            break;
          case 'about':
            setReadingMode(false);
            setShowLibrary(false);
            setShowSettings(true);
            break;
          case 'export-csv':
            exportFromMenu('csv');
            break;
          case 'export-anki':
            exportFromMenu('anki');
            break;
          case 'toggle-reading-mode':
            changeReadingMode(!readingMode);
            break;
          default:
            break;
        }
      }),
    [bus, exportFromMenu, changeReadingMode, readingMode],
  );

  /* The menu, when there is one. */
  const onMenuCommand = bridge?.onMenuCommand;

  useEffect(() => onMenuCommand?.(bus.dispatch), [onMenuCommand, bus]);

  /* The keyboard. Escape leaves reading mode before it does anything else. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) {
        return;
      }

      if (event.key === 'Escape' && readingMode) {
        event.preventDefault();
        changeReadingMode(false);

        return;
      }

      const command = keyboardCommand(event);

      if (command !== null) {
        event.preventDefault();
        bus.dispatch(command);
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [bus, readingMode, changeReadingMode]);

  const panelOpen = showLibrary || showSettings;

  /*
    The application's own controls. They are handed to the reader, which
    puts them at the end of its bar: one bar for the window, not a title
    row above a toolbar.

    CTL-3: each toggle has a fixed name that says where it leads, and
    `aria-pressed` carries whether the reader is there already.
  */
  const controls = (
    <div className="shell__actions" role="group" aria-label="Lexleaf">
      <button
        type="button"
        className="control shell__library-toggle"
        data-testid="library-toggle"
        aria-pressed={showLibrary}
        title="Saved words (Ctrl+L)"
        onClick={(): void => {
          bus.dispatch('toggle-saved-words');
        }}
      >
        <Icon name="bookmark" />
        Saved words
      </button>
      <button
        type="button"
        className="control shell__reading-toggle"
        data-testid="reading-mode-toggle"
        title="Reading mode: full screen, nothing but the page (F11)"
        onClick={(): void => {
          changeReadingMode(true);
        }}
      >
        <Icon name="expand" />
        Reading mode
      </button>
      <button
        type="button"
        className="control shell__settings-toggle"
        data-testid="settings-toggle"
        aria-pressed={showSettings}
        title="Settings (Ctrl+,)"
        onClick={(): void => {
          bus.dispatch('toggle-settings');
        }}
      >
        <Icon name="settings" />
        Settings
      </button>
    </div>
  );

  /*
    The application's notices. The reader shows them with its own, in the
    one place notices appear. Each is still the shared `Message`, announced
    once and dismissed by the reader; there is no toast, timer or queue.
  */
  const notices = (
    <>
      {bridge !== null && <VocabularyRecoveryPanel bridge={bridge} />}

      {message !== null && (
        <div className="shell__notice" data-testid="navigation-notice">
          <p className="shell__notice-text" role="status">
            {message}
          </p>
          <button
            type="button"
            className="control"
            onClick={(): void => {
              setMessage(null);
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {persistence.visible && (
        <Message kind="problem" className="shell__persistence" testId="persistence-notice">
          {PERSISTENCE_FAILURE_MESSAGE}{' '}
          <button type="button" className="control" onClick={persistence.dismiss}>
            Dismiss
          </button>
        </Message>
      )}

      {recovery.visible && (
        <Message kind="problem" className="shell__persistence" testId="recovery-notice">
          {RECOVERY_NOTICE_MESSAGE}{' '}
          <button type="button" className="control" onClick={recovery.dismiss}>
            Dismiss
          </button>
        </Message>
      )}

      {updates.noticeVisible && (
        <UpdateMessage
          updates={updates}
          testId="update-notice"
          className="shell__persistence"
          dismissible
        />
      )}
    </>
  );

  return (
    <div className={readingMode ? 'shell shell--reading' : 'shell'}>
      {/*
        A11Y-10. First in the DOM, so first in the tab order. The default
        action is prevented instead of letting the fragment navigate: this
        is a `file://` document, and changing the URL to move focus would
        be a navigation the application does not want.
      */}
      <a
        className="skip-link"
        href={`#${DOCUMENT_SCROLLER_ID}`}
        data-testid="skip-to-document"
        onClick={(event): void => {
          event.preventDefault();
          document.getElementById(DOCUMENT_SCROLLER_ID)?.focus();
        }}
      >
        Skip to document
      </a>

      {/*
        The book and, beside it, at most one panel. The book is never
        replaced: saved words and settings open next to the page, so a
        word can be checked against the sentence it came from. In a window
        too narrow for both, the stylesheet gives the panel the whole
        width, and its own close button brings the book back.
      */}
      <div className={panelOpen ? 'shell__body shell__body--panel' : 'shell__body'}>
        <div className="shell__surface" data-testid="reader-surface">
          <ReaderView
            bridge={bridge}
            occurrence={target}
            onOccurrenceOutcome={onOutcome}
            preferences={preferences}
            onWriteHealth={reportWriteHealth}
            trailing={controls}
            notices={notices}
            commands={bus}
            readingMode={readingMode}
            onExitReadingMode={(): void => {
              changeReadingMode(false);
            }}
          />
        </div>

        {showSettings && (
          <aside className="shell__panel" data-testid="side-panel">
            <SettingsPanel
              preferences={preferences}
              onChange={setPreference}
              onClose={(): void => {
                setShowSettings(false);
              }}
            >
              <UpdateSettings updates={updates} />
              {reportProblem !== undefined && <ReportProblem onReport={reportProblem} />}
              <section className="settings__group shell__about" data-testid="about">
                <h3 className="settings__legend">About Lexleaf</h3>
                <RuntimeDetails bridge={bridge} />
              </section>
            </SettingsPanel>
          </aside>
        )}

        {showLibrary && (
          <aside className="shell__panel" data-testid="side-panel">
            <LibraryView
              library={library}
              onOpenOrigin={openOrigin}
              onClose={(): void => {
                setShowLibrary(false);
              }}
              {...(bridge === null
                ? {}
                : { onExport: (format) => bridge.vocabulary.exportLibrary(format) })}
            />
          </aside>
        )}
      </div>

      {draggingFile && (
        <div className="shell__drop" data-testid="drop-target" aria-hidden="true">
          <p className="shell__drop-text">Drop the PDF to open it</p>
        </div>
      )}
    </div>
  );
};
