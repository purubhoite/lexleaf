import { useCallback, useMemo, useState } from 'react';

import type { StateWriteHealth } from '@shared/ipc/contracts';

/**
 * What the reader is told when reading state stops reaching the disk
 * (M7.2, ADR-034, M7 investigation R6).
 *
 * Three properties are deliberate, and each one is the answer to a way
 * this could have gone wrong:
 *
 * - it does not claim the write succeeded, and it does not claim it will
 *   succeed later. Until M7.2 the application looked exactly as it does
 *   when saving works, which is the defect;
 * - it does not interrupt. Reading is untouched, the document stays open,
 *   nothing is modal and nothing takes focus;
 * - it says nothing about *why*. The reason is an `errno` on a path, it
 *   lives in the main-process log, and no sentence here could help a
 *   reader act on it.
 */
export const PERSISTENCE_FAILURE_MESSAGE =
  'Your place in this document, the recent list and your settings cannot be saved at the moment. ' +
  'Reading is not affected, but this session may not be remembered next time.';

export interface PersistenceNotice {
  /** True while the one notice of this session is on screen. */
  readonly visible: boolean;
  /** Records the health reported by a write channel. */
  readonly report: (health: StateWriteHealth) => void;
  /** The reader has read it. It does not come back. */
  readonly dismiss: () => void;
}

/**
 * One notice per session, and only one.
 *
 * A reading position is written several times a minute, so a broken
 * profile directory produces a failed write every few seconds. The state
 * here is what stops that becoming a flood: the notice is raised by the
 * first `failing` report and never raised again, whether the reader
 * dismissed it or simply left it there. Later failures change nothing,
 * which is exactly the "do not spam" rule, kept in one place rather than
 * in each of the three callers.
 *
 * Recovery is not treated as news either: an `ok` after a `failing` does
 * not retract the notice. The sentence was true when it was shown, the
 * reader may have acted on it, and flickering a problem message in and
 * out of the chrome would be worse than leaving it until it is dismissed.
 */
export const usePersistenceNotice = (): PersistenceNotice => {
  const [state, setState] = useState<'quiet' | 'shown' | 'dismissed'>('quiet');

  const report = useCallback((health: StateWriteHealth): void => {
    if (health === 'failing') {
      setState((current) => (current === 'quiet' ? 'shown' : current));
    }
  }, []);

  const dismiss = useCallback((): void => {
    setState('dismissed');
  }, []);

  return useMemo(() => ({ visible: state === 'shown', report, dismiss }), [dismiss, report, state]);
};
