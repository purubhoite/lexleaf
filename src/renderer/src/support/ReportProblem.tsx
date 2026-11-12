import { useState, type ReactElement } from 'react';

import { Message } from '../ui/Message';

/**
 * "Report a problem", in the settings screen.
 *
 * The button opens a new-issue page on GitHub in the reader's browser,
 * with the version and operating system already written in. Lexleaf sends
 * nothing itself: the reader reads the report, edits it, and submits it or
 * closes the tab. The note says so, because this sits one group below the
 * promise that only the update check uses the internet.
 */

export interface ReportProblemProps {
  /** Opens the report. Resolves `false` when the browser could not be opened. */
  readonly onReport: () => Promise<boolean>;
}

export const REPORT_ADDRESS_TEXT = 'github.com/purubhoite/lexleaf/issues';

export const ReportProblem = ({ onReport }: ReportProblemProps): ReactElement => {
  const [failed, setFailed] = useState(false);

  return (
    <fieldset className="settings__group" data-testid="setting-report-problem">
      <legend className="settings__legend">Report a problem</legend>
      <p className="settings__note">
        Opens a page on GitHub in your browser with your Lexleaf version and operating system filled
        in, so you only have to describe what went wrong. Lexleaf sends nothing by itself: you see
        the whole report and choose whether to submit it. Submitting needs a free GitHub account.
      </p>

      <div>
        <button
          type="button"
          className="control"
          data-testid="report-problem"
          onClick={(): void => {
            setFailed(false);
            void onReport().then(
              (opened) => {
                setFailed(!opened);
              },
              () => {
                setFailed(true);
              },
            );
          }}
        >
          Report a problem…
        </button>
      </div>

      {failed && (
        <Message kind="problem" testId="report-problem-failed">
          Your browser could not be opened. You can report the problem at {REPORT_ADDRESS_TEXT}.
        </Message>
      )}
    </fieldset>
  );
};
