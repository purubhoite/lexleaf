/**
 * Quitting without losing the last thing the reader did (M7.3, L1).
 *
 * Reading state is written on a debounce, so at any moment up to one
 * delay's worth of position changes exists only in memory. `before-quit`
 * used to start the flush with `void` and let the process continue
 * tearing itself down around it: whether those bytes landed depended on
 * which finished first. Usually the write won. "Usually" is not a
 * guarantee, and the page the reader was on when they pressed Cmd-Q is
 * exactly the state they will notice missing.
 *
 * So the first `before-quit` is cancelled, the flush is awaited, and the
 * quit is reissued afterwards. Three rules keep that from becoming a
 * hang:
 *
 * - the flush is bounded by a timeout, and a timeout quits anyway;
 * - a flush that rejects quits anyway;
 * - the second `before-quit` — the one this issues itself — is not
 *   intercepted, so there is no cycle.
 *
 * The guarantee is still "the last committed state", not every event:
 * a position produced during the flush itself belongs to the next
 * session's problem, not this one's.
 */

export type QuitFlushPhase = 'idle' | 'flushing' | 'done';

/**
 * What the persistence layer actually did (M7.3, C-2).
 *
 * The store diagnoses a failed write instead of throwing, so a resolved
 * flush is not evidence that anything reached the disk. The caller
 * reports which it was, and the wording below follows it.
 */
export type QuitFlushPersistence = 'saved' | 'not-saved';

export type QuitFlushOutcome = 'flushed' | 'not-saved' | 'failed' | 'timed-out';

export interface QuitFlushEvent {
  preventDefault(): void;
}

export interface QuitFlushOptions {
  /**
   * Writes anything pending and reports whether the latest state reached
   * the disk. Expected to resolve; rejection is handled too.
   */
  readonly flush: () => Promise<QuitFlushPersistence>;
  /** Reissued once the flush has settled, one way or another. */
  readonly quit: () => void;
  readonly onDiagnostic: (message: string) => void;
  /** Upper bound on how long quitting may wait. Small on purpose. */
  readonly timeoutMs?: number;
  /** Injected so the bound is tested without waiting for it. */
  readonly setTimer?: (handler: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface QuitFlush {
  /** Call from `app.on('before-quit')`. */
  onBeforeQuit(event: QuitFlushEvent): void;
  phase(): QuitFlushPhase;
}

export const DEFAULT_QUIT_FLUSH_TIMEOUT_MS = 2_000;

export const createQuitFlush = ({
  flush,
  quit,
  onDiagnostic,
  timeoutMs = DEFAULT_QUIT_FLUSH_TIMEOUT_MS,
  setTimer = (handler, ms): unknown => setTimeout(handler, ms),
  clearTimer = (handle): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
}: QuitFlushOptions): QuitFlush => {
  let phase: QuitFlushPhase = 'idle';

  const settle = (outcome: QuitFlushOutcome): void => {
    if (phase === 'done') {
      return;
    }

    phase = 'done';

    if (outcome === 'flushed') {
      onDiagnostic('reading state was flushed before quitting');
    } else if (outcome === 'not-saved') {
      /*
       * The flush ran and the write did not succeed. Saying it was
       * flushed here — which this did until C-2 — described the call
       * rather than the disk, and was simply untrue of the state.
       */
      onDiagnostic(
        'the latest reading state could not be saved before quitting; the last saved state is unchanged',
      );
    } else if (outcome === 'failed') {
      onDiagnostic('reading state could not be flushed before quitting; quitting anyway');
    } else {
      onDiagnostic(
        'reading state did not finish being flushed in time; quitting without waiting further',
      );
    }

    quit();
  };

  return {
    onBeforeQuit(event: QuitFlushEvent): void {
      if (phase === 'done') {
        // The quit this module asked for. Let it through untouched.
        return;
      }

      event.preventDefault();

      if (phase === 'flushing') {
        // A second Cmd-Q while the first is still writing. Waiting is the
        // whole point; a second flush would not make it land sooner.
        return;
      }

      phase = 'flushing';

      let timer: unknown = null;
      let settled = false;

      const finish = (outcome: QuitFlushOutcome): void => {
        if (settled) {
          return;
        }

        settled = true;

        if (timer !== null) {
          clearTimer(timer);
        }

        settle(outcome);
      };

      timer = setTimer(() => {
        finish('timed-out');
      }, timeoutMs);

      void flush().then(
        (persistence) => {
          finish(persistence === 'saved' ? 'flushed' : 'not-saved');
        },
        () => {
          finish('failed');
        },
      );
    },

    phase: (): QuitFlushPhase => phase,
  };
};
