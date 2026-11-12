import type { ReactElement } from 'react';

import { Message } from '../ui/Message';

import type { UpdateCheck } from './useUpdateCheck';

/**
 * The update group of the settings screen.
 *
 * It is a component of its own rather than a fifth preference: the four
 * settings of ADR-031 describe how a document is shown and are stored with
 * the reading state, while this one describes the application and is the
 * only setting that can cause a request to leave the computer. Keeping it
 * apart keeps that difference visible, to a reader and in the code.
 *
 * Built from the same fieldset, radio and note the other groups use, so it
 * looks and behaves like them.
 */

export interface UpdateSettingsProps {
  readonly updates: UpdateCheck;
}

const describeOutcome = (updates: UpdateCheck): ReactElement | null => {
  if (updates.activity === 'checking') {
    return (
      <Message kind="busy" testId="update-status">
        Checking for updates…
      </Message>
    );
  }

  switch (updates.outcome.status) {
    case 'available':
      return (
        <Message kind="info" testId="update-status">
          Lexleaf {updates.outcome.version} is available.{' '}
          <button type="button" className="control" onClick={updates.openDownload}>
            Open the download page
          </button>
        </Message>
      );
    case 'up-to-date':
      return (
        <Message kind="info" testId="update-status">
          You have the latest version.
        </Message>
      );
    case 'failed':
      return (
        <Message kind="problem" testId="update-status">
          Lexleaf could not check for updates. Check your internet connection and try again.
        </Message>
      );
    default:
      return null;
  }
};

export const UpdateSettings = ({ updates }: UpdateSettingsProps): ReactElement | null => {
  if (!updates.supported) {
    return null;
  }

  return (
    <fieldset className="settings__group" data-testid="setting-updates">
      <legend className="settings__legend">Updates</legend>
      <p className="settings__note">
        Lexleaf can ask GitHub, at most once a day, whether a newer version has been released, and
        tell you when one has. Nothing is downloaded or installed for you, and nothing about you,
        your documents or your saved words is sent. This is the only setting that uses the internet.
      </p>

      <label className="settings__choice">
        <input
          type="radio"
          className="settings__radio"
          name="automaticUpdateCheck"
          value="on"
          checked={updates.automatic}
          onChange={(): void => {
            updates.setAutomatic(true);
          }}
        />
        <span className="settings__choice-text">
          <span className="settings__choice-label">Check automatically</span>
          <span className="settings__choice-description">
            Looks when Lexleaf starts, no more than once a day.
          </span>
        </span>
      </label>

      <label className="settings__choice">
        <input
          type="radio"
          className="settings__radio"
          name="automaticUpdateCheck"
          value="off"
          checked={!updates.automatic}
          onChange={(): void => {
            updates.setAutomatic(false);
          }}
        />
        <span className="settings__choice-text">
          <span className="settings__choice-label">Never check automatically</span>
          <span className="settings__choice-description">
            Lexleaf contacts nothing unless you press the button below.
          </span>
        </span>
      </label>

      <div>
        <button
          type="button"
          className="control"
          data-testid="update-check-now"
          disabled={updates.activity === 'checking'}
          onClick={updates.checkNow}
        >
          Check for updates now
        </button>
      </div>

      {describeOutcome(updates)}
    </fieldset>
  );
};
