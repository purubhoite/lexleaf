import { useCallback, useState, type ReactElement } from 'react';

import type { SavedWord } from '@core/vocabulary/types';
import type { DesktopBridge } from '@shared/ipc/contracts';

import { LibraryView } from '../library/LibraryView';
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

import { APP_INFO_FAILURE_MESSAGES, useAppInfo } from './useAppInfo';
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
        setShowLibrary(false);
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

  return (
    <div className="shell">
      {/*
        A11Y-10. First in the DOM, so first in the tab order, and rendered
        only while the reader is on screen: with the library open the
        document surface is `hidden`, and a link that moves focus to a
        hidden region would be a trap rather than a shortcut.

        The default action is prevented instead of letting the fragment
        navigate: this is a `file://` document, and changing the URL to
        move focus would be a navigation the application does not want.
      */}
      {!showLibrary && !showSettings && (
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
      )}

      {/*
        W16, CTL-10. One compact row: the application's own name, the two
        chrome controls, nothing else. The window already carries a title
        bar, so the heading is sized as a heading of a small region rather
        than as a product wordmark, and the row never grows a second line.
      */}
      <div className="shell__header">
        <h1 className="shell__title">Lexleaf</h1>
        <div className="shell__actions">
          {/*
            CTL-3's rule, applied to the library toggle (6.4, Part 3).

            The label used to flip between "Saved words" and "Back to
            reading", which renamed the control every time it was pressed:
            to assistive technology the button's identity changed rather
            than its state. The name is now fixed and names the thing the
            button leads to; `aria-pressed` carries whether the reader is
            there already. The visible text is the accessible name, so it
            has to be the stable one too — an `aria-label` that disagreed
            with changing visible text would break WCAG 2.5.3. The way back
            is not lost: the library screen renders its own "Back to
            reading" button, and this control is a toggle besides.
          */}
          <button
            type="button"
            className="control shell__library-toggle"
            data-testid="library-toggle"
            aria-pressed={showLibrary}
            onClick={(): void => {
              setShowSettings(false);
              setShowLibrary((current) => !current);
            }}
          >
            Saved words
          </button>
          {/*
            The settings toggle, built exactly like the library one above
            and for the same reasons: a fixed name that says where it
            leads, `aria-pressed` for whether the reader is there, and the
            panel itself offering its own way back.
          */}
          <button
            type="button"
            className="control shell__settings-toggle"
            data-testid="settings-toggle"
            aria-pressed={showSettings}
            onClick={(): void => {
              setShowLibrary(false);
              setShowSettings((current) => !current);
            }}
          >
            Settings
          </button>
          <details className="shell__about">
            <summary className="disclosure__summary">About Lexleaf</summary>
            <RuntimeDetails bridge={bridge} />
          </details>
        </div>
      </div>

      {bridge !== null && <VocabularyRecoveryPanel bridge={bridge} />}

      {message !== null && (
        <p className="shell__notice" role="status" data-testid="navigation-notice">
          {message}
        </p>
      )}

      {/*
        R6's answer, and nothing more than R6's answer. It is the shared
        `Message` in its `problem` kind — so it is announced once, as an
        alert, and painted like every other failure in the product — laid
        out with the class the navigation notice already uses. There is no
        toast, no timer, no portal and no queue: this is the only message
        of its kind the session can produce, and the reader closes it.
      */}
      {persistence.visible && (
        <Message kind="problem" className="shell__persistence" testId="persistence-notice">
          {PERSISTENCE_FAILURE_MESSAGE}{' '}
          <button type="button" className="control" onClick={persistence.dismiss}>
            Dismiss
          </button>
        </Message>
      )}

      {/*
        R1's answer. The window the reader is looking at is not the one
        they had a moment ago, and saying nothing about that would be the
        same silence the investigation found. It is the shared `Message`
        in its `problem` kind, dismissible, and it interrupts nothing: the
        document is already reopening behind it.
      */}
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

      <div
        className="shell__surface"
        hidden={showLibrary || showSettings}
        data-testid="reader-surface"
      >
        <ReaderView
          bridge={bridge}
          occurrence={target}
          onOccurrenceOutcome={onOutcome}
          preferences={preferences}
          onWriteHealth={reportWriteHealth}
        />
      </div>

      {showSettings && (
        <SettingsPanel
          preferences={preferences}
          onChange={setPreference}
          onClose={(): void => {
            setShowSettings(false);
          }}
        >
          <UpdateSettings updates={updates} />
          {reportProblem !== undefined && <ReportProblem onReport={reportProblem} />}
        </SettingsPanel>
      )}

      {showLibrary && (
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
      )}
    </div>
  );
};
