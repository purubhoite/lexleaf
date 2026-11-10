import type { SessionRecovery } from '@shared/ipc/contracts';

/**
 * What happens when the renderer dies (M7.1, ADR-035, M7 investigation R1).
 *
 * Before this existed, a crashed renderer left the window on screen,
 * painted with whatever it last drew, answering nothing. The application
 * process stayed alive, `main window ready` was logged exactly once for
 * the whole session, and the only way out was to quit and relaunch —
 * which nothing told the reader to do.
 *
 * The rule here is "one attempt, then explain", and the reason it is a
 * state machine rather than a pair of booleans is that the dangerous
 * failure mode is not the crash: it is recovery logic that reloads a
 * window which crashes on load, for ever. Every transition below is
 * written down, and there is no path from `failed` back to anything.
 *
 * ```
 *   healthy ──crash──▶ recovering ──the replacement renderer is usable──▶ recovered
 *                          │                                                 │
 *                          │ crash again                         crash again │
 *                          ▼                                                 │
 *                        failed   (terminal; no further reload) ◀────────────┘
 * ```
 *
 * There is no edge back to `healthy`. Once a death has been seen the
 * session's one attempt is spent, whichever way it turns out: `recovered`
 * is as final as `failed` in that respect, and only a new process starts
 * at `healthy` again.
 *
 * `stalled` is a **separate flag, not a state**. `unresponsive` sets it
 * and `responsive` clears it; neither touches the machine above, so a
 * window that stops answering and starts again is still `healthy`, and
 * one that stops answering while `recovering` is still `recovering`.
 *
 * ```
 *   (any state)  ──unresponsive──▶ stalled = true
 *                ──responsive────▶ stalled = false
 * ```
 *
 * - **healthy** — the ordinary state. A renderer is alive, or none has
 *   died yet.
 * - **recovering** — a death has been seen and exactly one reload has been
 *   asked for. Nothing else will be asked for while in this state.
 * - **recovered** — the replacement renderer reached a usable state. The
 *   reader is told, once, that this happened. The session's automatic
 *   attempt is now spent.
 * - **failed** — terminal. Either the replacement died too, or a second
 *   death arrived after a successful recovery. No reload is attempted, the
 *   dead window is not left pretending to work, and the reader is told
 *   plainly that the application has to be restarted.
 *
 * `unresponsive` is deliberately **not** a death (§9): a renderer that is
 * busy is not a renderer that is gone, and a long synchronous page render
 * must not be answered with a reload. It is recorded, and `responsive`
 * clears it.
 */

/** The four states above. Nothing else is a state. */
export const RECOVERY_STATES = ['healthy', 'recovering', 'recovered', 'failed'] as const;

export type RecoveryState = (typeof RECOVERY_STATES)[number];

/**
 * Why the renderer went away, as the main process understands it.
 *
 * Chromium distinguishes a clean exit from a crash, an out-of-memory kill
 * and a few others. Only `clean-exit` is not a defect: it is what happens
 * when the window is closing normally, and reloading then would fight the
 * application's own shutdown.
 */
export interface RendererDeath {
  /** Electron's `details.reason`. */
  readonly reason: string;
  /** Electron's `details.exitCode`. */
  readonly exitCode: number;
}

export interface RendererRecoveryOptions {
  /**
   * Reloads the window. Called at most once per session, and never from
   * `failed`.
   */
  readonly reload: () => void;
  /**
   * The honest end of the road: the replacement renderer died too, so
   * there is no surface left to put a message on. Called at most once.
   */
  readonly onTerminalFailure: () => void;
  /** Main-process log. The reason, the exit code and nothing user-facing. */
  readonly onDiagnostic: (message: string) => void;
}

export interface RendererRecovery {
  /** The current state, for tests and for the diagnostic log. */
  readonly state: () => RecoveryState;
  /**
   * What the next renderer should be told about itself. `after-crash`
   * only while a recovery is in flight or has just succeeded, so an
   * ordinary reload the reader asked for says nothing.
   */
  readonly notice: () => SessionRecovery;
  /** True while the renderer has stopped answering but has not died. */
  readonly stalled: () => boolean;
  /** Electron's `render-process-gone`. */
  readonly onRendererGone: (death: RendererDeath) => void;
  /** Electron's `unresponsive`. Recorded, never acted on. */
  readonly onUnresponsive: () => void;
  /** Electron's `responsive`. Clears the transient state above. */
  readonly onResponsive: () => void;
  /** The replacement renderer reached a usable state. */
  readonly onRendererReady: () => void;
}

/**
 * A renderer that exited on purpose. Reloading this is a bug, not a fix:
 * it is what Chromium reports while the window is being closed.
 */
const isCleanExit = (death: RendererDeath): boolean => death.reason === 'clean-exit';

export const createRendererRecovery = ({
  reload,
  onTerminalFailure,
  onDiagnostic,
}: RendererRecoveryOptions): RendererRecovery => {
  let state: RecoveryState = 'healthy';
  let stalled = false;

  const describe = (death: RendererDeath): string =>
    `reason=${death.reason} exitCode=${String(death.exitCode)}`;

  return {
    state: () => state,

    /*
     * `recovering` answers `after-crash` as well as `recovered` because
     * the renderer that asks is the replacement: it asks for its state
     * while the recovery is still in flight, and it is the one that has
     * to carry the message.
     */
    notice: (): SessionRecovery =>
      state === 'recovering' || state === 'recovered' ? 'after-crash' : 'none',

    stalled: () => stalled,

    onRendererGone: (death: RendererDeath): void => {
      if (isCleanExit(death)) {
        // The window is closing. Nothing is wrong and nothing is reloaded.
        onDiagnostic(`the reader window exited cleanly (${describe(death)})`);
        return;
      }

      // A process that has gone is not a process that is merely busy.
      stalled = false;

      switch (state) {
        case 'healthy': {
          state = 'recovering';
          onDiagnostic(
            `the reader window stopped unexpectedly (${describe(death)}); reloading it once`,
          );
          reload();
          return;
        }

        case 'recovering':
        case 'recovered': {
          /*
           * The second death of the session. Whether it arrived during
           * the reload or after a recovery that looked successful, the
           * conclusion is the same: this application cannot keep a
           * renderer alive, and reloading again would be a loop with a
           * reader watching it. One attempt was the promise.
           */
          state = 'failed';
          onDiagnostic(
            `the reader window stopped again (${describe(death)}); recovery is given up`,
          );
          onTerminalFailure();
          return;
        }

        default: {
          // Already terminal. Nothing is attempted, nothing is repeated.
          onDiagnostic(
            `the reader window stopped while already unrecoverable (${describe(death)})`,
          );
          return;
        }
      }
    },

    onUnresponsive: (): void => {
      /*
       * §9: this is not a crash and must not be treated as one. A page
       * that takes a long time to lay out, a synchronous chunk of PDF
       * work, a machine under load — all of them produce this event and
       * all of them end with `responsive`. It is recorded so that a
       * reader reporting "it froze" has something in the log, and that
       * is all it does.
       */
      if (!stalled) {
        stalled = true;
        onDiagnostic('the reader window stopped answering; waiting for it to come back');
      }
    },

    onResponsive: (): void => {
      if (stalled) {
        stalled = false;
        onDiagnostic('the reader window is answering again');
      }
    },

    onRendererReady: (): void => {
      if (state === 'recovering') {
        state = 'recovered';
        onDiagnostic('the replacement reader window is usable');
      }
    },
  };
};
