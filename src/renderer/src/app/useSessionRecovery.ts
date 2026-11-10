import { useEffect, useState } from 'react';

import type { DesktopBridge } from '@shared/ipc/contracts';

/**
 * What the reader is told after the window has been rebuilt under them
 * (M7.1, ADR-035, M7 investigation R1).
 *
 * The sentence says the three things a reader actually needs: that it
 * happened, that their reading was restored as far as it had been saved,
 * and that nothing of theirs was thrown away. It does not say "crash",
 * it does not name a process, and it carries no exit code — the main
 * process keeps all of that in its log.
 *
 * It is careful not to over-promise. The position restored is the last
 * one *committed* to disk, which is not necessarily the last one the
 * reader was at: writes are debounced, and making them durable is 7.3's
 * work, not this slice's. "as far as it had been saved" is the honest
 * phrasing of that and is deliberate.
 */
export const RECOVERY_NOTICE_MESSAGE =
  'The reader stopped unexpectedly and has been reopened. ' +
  'Your document has been restored as far as it had been saved, and your saved words are unaffected.';

export interface RecoveryNotice {
  /** True while the one notice of this session is on screen. */
  readonly visible: boolean;
  /** The reader has read it. It does not come back. */
  readonly dismiss: () => void;
}

/**
 * Asks the state snapshot how this renderer came to exist.
 *
 * There is no channel for this and no message from the main process: the
 * shell already reads its state at startup, the answer is a closed value
 * on that reply, and a renderer that has just been rebuilt reads it on
 * the way up like any other. One ask, one notice, dismissible, and
 * nothing repeats it.
 */
export const useSessionRecovery = (bridge: DesktopBridge | null): RecoveryNotice => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (bridge === null) {
      return;
    }

    let cancelled = false;

    void bridge.getReaderState().then(
      (snapshot) => {
        if (!cancelled && snapshot.sessionRecovery === 'after-crash') {
          setVisible(true);
        }
      },
      () => {
        // A state snapshot that cannot be read is not evidence of a
        // crash, and this notice must never be the reason a reader
        // believes something went wrong.
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, [bridge]);

  return {
    visible,
    dismiss: (): void => {
      setVisible(false);
    },
  };
};
