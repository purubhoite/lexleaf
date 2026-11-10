import type { ReactElement } from 'react';

import type { RecentDocument } from '@shared/ipc/contracts';

import { Message } from '../ui/Message';

/**
 * What the reader has read before.
 *
 * Entries are identified by id, never by path: the renderer is not told
 * where the files are (ADR-016). An entry whose file has gone is shown as
 * unavailable rather than hidden, so that "my book disappeared" is something
 * the reader can see and dismiss instead of a silent omission.
 */

export interface RecentDocumentsProps {
  readonly recents: readonly RecentDocument[];
  readonly onOpen: (documentId: string) => void;
  readonly onForget: (documentId: string) => void;
}

const describe = (recent: RecentDocument): string => {
  const pages = recent.pageCount === null ? '' : ` of ${String(recent.pageCount)}`;

  return `page ${String(recent.lastPage)}${pages}`;
};

export const RecentDocuments = ({
  recents,
  onOpen,
  onForget,
}: RecentDocumentsProps): ReactElement => {
  if (recents.length === 0) {
    // ST-5: an empty state says what to do next, not only that it is
    // empty. The control it names is the one directly above this list.
    return (
      <Message kind="empty">
        No documents have been opened yet. Use “Open PDF…” to start reading.
      </Message>
    );
  }

  return (
    <ul className="recents">
      {recents.map((recent) => (
        <li key={recent.id} className="recents__item">
          <button
            type="button"
            className="control recents__open"
            disabled={!recent.available}
            onClick={(): void => {
              onOpen(recent.id);
            }}
          >
            <span className="recents__name">{recent.name}</span>
            <span className="recents__meta">
              {recent.available ? describe(recent) : 'file not found'}
            </span>
          </button>
          <button
            type="button"
            className="control recents__forget"
            aria-label={`Remove ${recent.name} from recent documents`}
            onClick={(): void => {
              onForget(recent.id);
            }}
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
};
