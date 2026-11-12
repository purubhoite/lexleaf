import { useEffect, useState } from 'react';

import type { DesktopBridge } from '@shared/ipc/contracts';

/**
 * How many words have been saved from each document, by document id.
 *
 * For the start screen, where each recent book says how many words the
 * reader has collected from it. Asked for once whenever the start screen
 * comes back; a failure simply leaves the counts out.
 */
export const useSavedWordCounts = (
  bridge: DesktopBridge | null,
  active: boolean,
): ReadonlyMap<string, number> => {
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());

  useEffect(() => {
    if (bridge === null || !active) {
      return undefined;
    }

    let current = true;

    void bridge.vocabulary.list({ sort: 'newest', documentId: null, cursor: null, limit: 1 }).then(
      (reply) => {
        if (current && reply.ok) {
          setCounts(new Map(reply.value.documents.map((entry) => [entry.documentId, entry.count])));
        }
      },
      () => undefined,
    );

    return (): void => {
      current = false;
    };
  }, [bridge, active]);

  return counts;
};
