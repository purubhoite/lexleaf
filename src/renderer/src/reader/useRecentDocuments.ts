import { useCallback, useEffect, useState } from 'react';

import {
  EMPTY_READER_STATE_SNAPSHOT,
  type DesktopBridge,
  type ReaderStateSnapshot,
  type StateWriteHealth,
} from '@shared/ipc/contracts';

/**
 * The recent-document list, as the renderer sees it.
 *
 * The renderer holds no storage of its own: this is a cached copy of what the
 * main process reports, refreshed when a document is opened or forgotten
 * (ADR-016). A failure to read it leaves the list empty rather than
 * interrupting anything — recents are a convenience, not part of reading.
 */

const EMPTY: ReaderStateSnapshot = EMPTY_READER_STATE_SNAPSHOT;

export interface RecentDocumentsControls {
  readonly snapshot: ReaderStateSnapshot;
  readonly refresh: () => void;
  readonly forget: (documentId: string) => void;
}

export const useRecentDocuments = (
  bridge: DesktopBridge | null,
  onWriteHealth?: (health: StateWriteHealth) => void,
): RecentDocumentsControls => {
  const [snapshot, setSnapshot] = useState<ReaderStateSnapshot>(EMPTY);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (bridge === null) {
      return;
    }

    let cancelled = false;

    void bridge.getReaderState().then(
      (next) => {
        if (!cancelled) {
          setSnapshot(next);
        }
      },
      () => undefined,
    );

    return (): void => {
      cancelled = true;
    };
  }, [bridge, reloads]);

  const refresh = useCallback((): void => {
    setReloads((count) => count + 1);
  }, []);

  const forget = useCallback(
    (documentId: string): void => {
      if (bridge === null) {
        return;
      }

      // Removed locally at once so the list does not appear to ignore the
      // click while the main process writes the file.
      setSnapshot((current) => ({
        ...current,
        recents: current.recents.filter((recent) => recent.id !== documentId),
        lastDocumentId: current.lastDocumentId === documentId ? null : current.lastDocumentId,
      }));

      // Forgetting a document is a write like any other, so it reports
      // like any other (M7.2): the list is already correct on screen, and
      // whether the change reached the disk is a separate question.
      void bridge.forgetDocument(documentId).then(
        (health) => {
          onWriteHealth?.(health);
          refresh();
        },
        () => undefined,
      );
    },
    [bridge, onWriteHealth, refresh],
  );

  return { snapshot, refresh, forget };
};
