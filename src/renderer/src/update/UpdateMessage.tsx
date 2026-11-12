import type { ReactElement } from 'react';

import { Message } from '../ui/Message';

import type { UpdateCheck } from './useUpdateCheck';

/**
 * What Lexleaf says about a newer release, and the buttons that go with it.
 *
 * One component for both places it is said — the notice in the shell and
 * the update group in settings — so the two can never disagree about what
 * state an update is in or what the reader can do next.
 *
 * Downloading and installing are separate buttons on purpose: finding an
 * update never downloads it, and downloading it never closes the
 * application. Each step waits for the reader.
 */

export interface UpdateMessageProps {
  readonly updates: UpdateCheck;
  readonly testId: string;
  /** Layout class from the surface that places the message. */
  readonly className?: string;
  /** Adds the button that hides the message for this session. */
  readonly dismissible?: boolean;
}

export const UpdateMessage = ({
  updates,
  testId,
  className,
  dismissible = false,
}: UpdateMessageProps): ReactElement | null => {
  const { outcome } = updates;

  const dismiss = (label: string): ReactElement | null =>
    dismissible ? (
      <>
        {' '}
        <button type="button" className="control" onClick={updates.dismissNotice}>
          {label}
        </button>
      </>
    ) : null;

  const downloadPage = (
    <button type="button" className="control" onClick={updates.openDownload}>
      Open the download page
    </button>
  );

  const placement = className === undefined ? {} : { className };

  switch (outcome.status) {
    case 'available':
      return (
        <Message kind="info" testId={testId} {...placement}>
          Lexleaf {outcome.version} is available.{' '}
          {outcome.canInstall ? (
            <button type="button" className="control" onClick={updates.download}>
              Download update
            </button>
          ) : (
            downloadPage
          )}
          {dismiss('Dismiss')}
        </Message>
      );
    case 'downloading':
      return (
        <Message kind="busy" testId={testId} {...placement}>
          Downloading Lexleaf {outcome.version}… You can keep reading; this can take a few minutes.
        </Message>
      );
    case 'ready':
      return (
        <Message kind="info" testId={testId} {...placement}>
          Lexleaf {outcome.version} is ready to install. Lexleaf will close and reopen.{' '}
          <button type="button" className="control" onClick={updates.install}>
            Restart and install
          </button>
          {dismiss('Later')}
        </Message>
      );
    case 'download-failed':
      return (
        <Message kind="problem" testId={testId} {...placement}>
          Lexleaf {outcome.version} could not be downloaded.{' '}
          <button type="button" className="control" onClick={updates.download}>
            Try again
          </button>{' '}
          {downloadPage}
          {dismiss('Dismiss')}
        </Message>
      );
    default:
      return null;
  }
};
