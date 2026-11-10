import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { ReadingPosition } from '@core/persistence/types';
import type { DesktopBridge, StateWriteHealth } from '@shared/ipc/contracts';

/**
 * Remembering where the reader is.
 *
 * Scrolling produces a new position many times a second, so updates are
 * coalesced here before they reach the main process, which coalesces them
 * again before they reach the disk (ADR-016). The last position is flushed
 * when the document changes or the window goes away, because that is exactly
 * the position a reader expects to find on their return.
 *
 * Every failure is swallowed: losing a bookmark must never interrupt
 * reading. Swallowed is not the same as unreported — since M7.2 the main
 * process answers each save with the health of the last write, and that
 * answer is handed to `onWriteHealth` for whoever owns the notice to deal
 * with (ADR-034). This hook still never renders anything and still never
 * throws.
 */

/** How long a position is held before it is sent. */
const SETTLE_MS = 600;

export interface PositionRecorder {
  /** Records a position; the write itself happens later. */
  readonly record: (position: ReadingPosition) => void;
  /**
   * Sends whatever is pending immediately, resolving once every position
   * sent so far has been acknowledged by the main process. Callers that read
   * the state back — the recent list, for instance — need that ordering, or
   * they would show the page the reader was on before the last move.
   */
  readonly flush: () => Promise<void>;
}

export const useReadingPosition = (
  bridge: DesktopBridge | null,
  documentId: string | null,
  pageCount: number | null,
  onWriteHealth?: (health: StateWriteHealth) => void,
): PositionRecorder => {
  const pending = useRef<ReadingPosition | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const context = useRef({ documentId, pageCount });
  const inFlight = useRef<Promise<void>>(Promise.resolve());
  /*
   * Held in a ref so that a caller passing an inline function does not
   * rebuild `send` — and with it the debounce timer and the flush effect
   * — on every render of the reader.
   */
  const report = useRef(onWriteHealth);

  useEffect(() => {
    report.current = onWriteHealth;
  }, [onWriteHealth]);

  // Updated after the render that changed it, so the cleanup below still
  // flushes the *previous* document's position before the switch.
  useEffect(() => {
    context.current = { documentId, pageCount };
  }, [documentId, pageCount]);

  const send = useCallback((): Promise<void> => {
    const position = pending.current;
    const { documentId: id, pageCount: pages } = context.current;

    pending.current = null;

    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }

    if (bridge === null || id === null || position === null) {
      // Nothing new to send, but an earlier save may still be travelling.
      return inFlight.current;
    }

    const sent = bridge.saveReadingPosition({ documentId: id, position, pageCount: pages }).then(
      (health) => {
        report.current?.(health);
      },
      () => undefined,
    );

    inFlight.current = sent;

    return sent;
  }, [bridge]);

  const record = useCallback(
    (position: ReadingPosition): void => {
      pending.current = position;

      if (timer.current === null) {
        timer.current = setTimeout(send, SETTLE_MS);
      }
    },
    [send],
  );

  // Changing document, or closing the window, must not drop the last known
  // position of the document being left.
  useEffect(() => {
    const flushNow = (): void => {
      void send();
    };

    window.addEventListener('pagehide', flushNow);

    return (): void => {
      window.removeEventListener('pagehide', flushNow);
      flushNow();
    };
  }, [documentId, send]);

  // A stable object, so an effect may depend on the recorder itself.
  return useMemo(() => ({ record, flush: send }), [record, send]);
};
