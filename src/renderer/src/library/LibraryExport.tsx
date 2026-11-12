import { useState, type ReactElement } from 'react';

import type { VocabularyExportFormat, VocabularyExportOutcome } from '@core/vocabulary/export';

import { Message } from '../ui/Message';

/**
 * The two export buttons on the library screen.
 *
 * An export always writes every saved word, whatever the list is filtered
 * to, and the buttons say so. The reader chooses where the file goes in
 * the system's own save window; this component learns only whether a file
 * was written and how many words went into it.
 */

export type ExportLibrary = (format: VocabularyExportFormat) => Promise<VocabularyExportOutcome>;

export interface LibraryExportProps {
  readonly onExport: ExportLibrary;
}

type ExportState =
  | { readonly status: 'idle' }
  | { readonly status: 'working' }
  | { readonly status: 'done'; readonly outcome: VocabularyExportOutcome };

export const describeExportOutcome = (outcome: VocabularyExportOutcome): string | null => {
  switch (outcome.status) {
    case 'exported':
      return outcome.count === 1
        ? 'Exported 1 saved word.'
        : `Exported ${String(outcome.count)} saved words.`;
    case 'empty':
      return 'There are no saved words to export yet.';
    case 'failed':
      return 'The saved words could not be exported. Nothing was changed; try again or choose another folder.';
    case 'cancelled':
      // The reader closed the save window themselves; there is nothing to tell them.
      return null;
  }
};

export const LibraryExport = ({ onExport }: LibraryExportProps): ReactElement => {
  const [state, setState] = useState<ExportState>({ status: 'idle' });
  const working = state.status === 'working';

  const run = (format: VocabularyExportFormat): void => {
    if (working) {
      return;
    }

    setState({ status: 'working' });

    void onExport(format)
      .catch((): VocabularyExportOutcome => ({ status: 'failed' }))
      .then((outcome) => {
        setState({ status: 'done', outcome });
      });
  };

  const message = state.status === 'done' ? describeExportOutcome(state.outcome) : null;

  return (
    <div className="library__export" role="group" aria-label="Export all saved words">
      <span className="library__export-label">Export all</span>
      <button
        type="button"
        className="control"
        disabled={working}
        data-testid="library-export-csv"
        title="A spreadsheet file for Excel, LibreOffice or Google Sheets"
        onClick={(): void => {
          run('csv');
        }}
      >
        Spreadsheet (CSV)
      </button>
      <button
        type="button"
        className="control"
        disabled={working}
        data-testid="library-export-anki"
        title="A text file to bring in with File › Import in Anki"
        onClick={(): void => {
          run('anki');
        }}
      >
        Anki flashcards
      </button>
      {message !== null && state.status === 'done' && (
        <Message
          kind={state.outcome.status === 'failed' ? 'problem' : 'info'}
          testId="library-export-status"
        >
          {message}
        </Message>
      )}
    </div>
  );
};
