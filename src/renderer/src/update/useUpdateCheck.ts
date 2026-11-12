import { useCallback, useEffect, useMemo, useState } from 'react';

import type { DesktopBridge } from '@shared/ipc/contracts';
import type { UpdateIpcState, UpdateOutcome } from '@shared/ipc/updateContracts';

/**
 * What the shell knows about updates, and the three things it can ask.
 *
 * The hook asks once when the application starts. That request is not a
 * decision to contact anything: the main process applies the reader's
 * setting and the once-a-day limit, and answers `idle` when it did not
 * look. A check made with the button is the only one marked as manual.
 *
 * Nothing here can fail visibly except a check the reader asked for.
 */

export type UpdateActivity = 'quiet' | 'checking';

export interface UpdateCheck {
  /** False when this build has no update bridge: nothing is rendered. */
  readonly supported: boolean;
  readonly automatic: boolean;
  readonly outcome: UpdateOutcome;
  readonly activity: UpdateActivity;
  /** True while a newer version is known and the notice was not dismissed. */
  readonly noticeVisible: boolean;
  readonly checkNow: () => void;
  readonly setAutomatic: (automatic: boolean) => void;
  readonly openDownload: () => void;
  readonly dismissNotice: () => void;
}

const IDLE: UpdateOutcome = { status: 'idle' };

export const useUpdateCheck = (bridge: DesktopBridge | null): UpdateCheck => {
  const updates = bridge?.updates ?? null;

  const [automatic, setAutomaticState] = useState(true);
  const [outcome, setOutcome] = useState<UpdateOutcome>(IDLE);
  const [activity, setActivity] = useState<UpdateActivity>('quiet');
  const [dismissed, setDismissed] = useState(false);

  const accept = useCallback((state: UpdateIpcState): void => {
    setAutomaticState(state.automatic);
    setOutcome(state.outcome);
  }, []);

  useEffect(() => {
    if (updates === null) {
      return;
    }

    let current = true;

    void updates.check(false).then(
      (state) => {
        if (current) {
          accept(state);
        }
      },
      () => {
        // The startup check is never worth a message.
      },
    );

    return (): void => {
      current = false;
    };
  }, [accept, updates]);

  const checkNow = useCallback((): void => {
    if (updates === null) {
      return;
    }

    setActivity('checking');

    void updates
      .check(true)
      .then(
        (state) => {
          accept(state);
          // A reader who asks again wants to see the answer again.
          setDismissed(false);
        },
        () => {
          setOutcome({ status: 'failed' });
        },
      )
      .finally(() => {
        setActivity('quiet');
      });
  }, [accept, updates]);

  const setAutomatic = useCallback(
    (next: boolean): void => {
      if (updates === null) {
        return;
      }

      // Shown at once; the reply only confirms it.
      setAutomaticState(next);

      void updates.setAutomatic(next).then(
        (state) => {
          setAutomaticState(state.automatic);
        },
        () => {
          // The choice stays as the reader left it for this session.
        },
      );
    },
    [updates],
  );

  const openDownload = useCallback((): void => {
    if (updates !== null) {
      void updates.openDownload().catch(() => {
        // Nothing to say: the reader can press the button again.
      });
    }
  }, [updates]);

  const dismissNotice = useCallback((): void => {
    setDismissed(true);
  }, []);

  return useMemo(
    () => ({
      supported: updates !== null,
      automatic,
      outcome,
      activity,
      noticeVisible: updates !== null && outcome.status === 'available' && !dismissed,
      checkNow,
      setAutomatic,
      openDownload,
      dismissNotice,
    }),
    [
      activity,
      automatic,
      checkNow,
      dismissNotice,
      dismissed,
      openDownload,
      outcome,
      setAutomatic,
      updates,
    ],
  );
};
