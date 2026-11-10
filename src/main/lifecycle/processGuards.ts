/**
 * The main process's last resort (M7.1, ADR-035, M7 investigation R9).
 *
 * Two things were missing before this. There was no
 * `process.on('uncaughtException')` and no `('unhandledRejection')`
 * anywhere in the application, so a throw outside a handler ended the
 * process with Node's own output and nothing of the application's; and
 * `app.whenReady().then(bootstrap).catch(() => app.exit(1))` turned any
 * failure to start into an application that simply never appeared.
 *
 * What this module deliberately does **not** do is keep a broken process
 * alive. Node's default for both events is to terminate, and that default
 * is right: once an exception has escaped every frame, the main process
 * holds a SQLite handle, a half-written state file and a window, and none
 * of their invariants can be trusted. Swallowing the error to stay running
 * would trade a visible failure for a corrupted one. So these handlers
 * change exactly one thing — the failure stops being silent — and then let
 * the process end.
 *
 * Nothing here reaches the renderer. The exception text and the stack are
 * main-process diagnostics, which is the same rule ADR-034 set for
 * document failures.
 */

/** One line of diagnostic, and the exit that follows it. */
export interface ProcessGuardOptions {
  /** Main-process log. */
  readonly onDiagnostic: (message: string) => void;
  /**
   * Ends the process. Injected so the guard can be tested without a
   * process to kill, and so the caller decides between `app.exit` and
   * anything else it knows about.
   */
  readonly terminate: (code: number) => void;
  /** Where the handlers are registered. Injected for the same reason. */
  readonly target?: Pick<NodeJS.Process, 'on'>;
}

export interface ProcessGuards {
  /** True once a fatal event has been handled. */
  readonly tripped: () => boolean;
}

/** The exit code a last-resort failure uses. */
export const FATAL_EXIT_CODE = 1;

/**
 * Describes a thrown value for the log.
 *
 * The stack is included because this is the one place that will ever see
 * it, and a last-resort handler without a stack is a log line that cannot
 * be acted on. It never leaves the main process.
 */
export const describeFatal = (error: unknown): string => {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }

  return String(error);
};

/**
 * Installs the two handlers.
 *
 * The re-entrancy guard is the part that matters: a failure *inside* the
 * handler, or a second event arriving while the first is being dealt
 * with, must not start the same work again. The first one wins, the rest
 * are ignored, and there is no path on which this function calls itself.
 */
export const installProcessGuards = ({
  onDiagnostic,
  terminate,
  target = process,
}: ProcessGuardOptions): ProcessGuards => {
  let tripped = false;

  const fatal = (kind: string, error: unknown): void => {
    if (tripped) {
      // Already on the way out. A second report changes nothing and a
      // second `terminate` would be a recursive failure handler.
      return;
    }

    tripped = true;

    try {
      onDiagnostic(`${kind}; the application cannot continue safely: ${describeFatal(error)}`);
    } catch {
      // A logger that throws must not stop the exit below. There is
      // nowhere left to report this to.
    }

    terminate(FATAL_EXIT_CODE);
  };

  target.on('uncaughtException', (error: unknown) => {
    fatal('an unhandled exception reached the top of the main process', error);
  });

  target.on('unhandledRejection', (reason: unknown) => {
    fatal('an unhandled promise rejection reached the top of the main process', reason);
  });

  return { tripped: () => tripped };
};

export interface BootstrapFailureOptions {
  /** Main-process log. */
  readonly onDiagnostic: (message: string) => void;
  /**
   * Shows a native error box, when one can be shown at all.
   *
   * It is native on purpose. By the time bootstrap has failed there may
   * be no window, no preload and no renderer — the surface the M6.5
   * `Message` system lives on does not exist — so the only honest choice
   * is the one piece of user interface that needs none of them. It is
   * not a second message architecture: nothing else in the product uses
   * it, and it is reachable only on a path where the product's own
   * surface cannot be.
   */
  readonly showErrorBox: ((title: string, content: string) => void) | null;
  /** Ends the process. */
  readonly terminate: (code: number) => void;
}

/**
 * The native boxes. Fixed text: no exception, no `errno`, no path, no
 * exit code — ADR-034's rule applies here too, and these are the only
 * two strings in the product a reader can see without a renderer.
 */
export const RENDERER_LOST_TITLE = 'The reader stopped';
export const RENDERER_LOST_BODY =
  'The reader stopped twice and could not be restarted. Please close the application and ' +
  'open it again. Your saved words and your place in the document are unaffected.';

export interface TerminalRendererLossOptions {
  /**
   * Closes the dead window. Must happen **before** the box below: see
   * the ordering note on {@link reportTerminalRendererLoss}.
   */
  readonly destroyWindow: () => void;
  /** Shows the native box. Blocks until the reader dismisses it. */
  readonly showErrorBox: (title: string, content: string) => void;
  /** Main-process log. */
  readonly onDiagnostic: (message: string) => void;
}

/**
 * The end of the road for the renderer: close the dead window, then say
 * so (M7.1 audit condition C-1).
 *
 * **The order is the whole point of this function.** `showErrorBox` is
 * synchronous and modal: it does not return until the reader presses Ok.
 * Showing it first therefore leaves the dead window painted underneath
 * the box for as long as the reader takes to read it — a complete,
 * working-looking reader with no renderer behind it, which is precisely
 * the defect R1 described and this milestone promised to remove. The
 * audit caught it on screen.
 *
 * So the window is destroyed first and the message is shown to an empty
 * screen. Nothing else changes: the copy is the same fixed text, there
 * is no retry, no reload, no replacement window and nothing persisted.
 *
 * The diagnostic between the two steps reports what actually happened:
 * a closure is claimed only when the destroy returned.
 *
 * It lives here, as a function taking both steps as arguments, so that
 * the ordering is observable: a test can record the sequence of calls
 * rather than merely assert that both happened.
 */
export const reportTerminalRendererLoss = ({
  destroyWindow,
  showErrorBox,
  onDiagnostic,
}: TerminalRendererLossOptions): void => {
  let closed = false;

  try {
    destroyWindow();
    closed = true;
  } catch (error: unknown) {
    /*
     * A window that cannot be closed must not prevent the reader being
     * told. This is logged and then the message is shown anyway — the
     * alternative is silence on top of a failure.
     */
    onDiagnostic(`the dead reader window could not be closed: ${describeFatal(error)}`);
  }

  /*
   * Exactly one of the two diagnostics is written, and only the success
   * one claims a closure (M7.1 audit finding CF-1). Logging both left
   * the main-process evidence contradicting itself on the failure path,
   * and let a reader of the log — or the runtime harness — infer a
   * destruction that had not happened. The claim now follows the fact.
   *
   * Either way it is written before the blocking call, so the log still
   * records what was attempted ahead of the modal.
   */
  if (closed) {
    onDiagnostic('the dead reader window has been closed; showing the terminal message');
  } else {
    onDiagnostic('the dead reader window is still open; showing the terminal message anyway');
  }

  showErrorBox(RENDERER_LOST_TITLE, RENDERER_LOST_BODY);
};

export const BOOTSTRAP_FAILURE_TITLE = 'The reader could not start';
export const BOOTSTRAP_FAILURE_BODY =
  'Something went wrong while the application was starting, so it has to close. ' +
  'Starting it again may work. If it does not, the application needs to be reinstalled.';

/**
 * What happens when `bootstrap` throws.
 *
 * The distinction §6 of the authorisation draws is the whole of the
 * design. Before a window can exist there is no way to promise a visible
 * failure, and pretending otherwise in a log line would be a lie; so the
 * failure is written down, the reader is shown a native box **if** the
 * `app` is far enough along to draw one, and the process ends. There is
 * no second bootstrap attempt: whatever made the first one fail —
 * a `userData` directory that cannot be created, a missing preload — will
 * make the second fail too, and a retry loop at startup is the worst
 * possible place for one.
 *
 * Returns what was actually done, so the caller's log and the tests can
 * say which of the two paths was taken rather than guessing.
 */
export const reportBootstrapFailure = ({
  onDiagnostic,
  showErrorBox,
  terminate,
}: BootstrapFailureOptions): { readonly shownToUser: boolean } => {
  let shownToUser = false;

  if (showErrorBox !== null) {
    try {
      showErrorBox(BOOTSTRAP_FAILURE_TITLE, BOOTSTRAP_FAILURE_BODY);
      shownToUser = true;
    } catch (error: unknown) {
      // The box is a courtesy; failing to draw one must not replace the
      // original failure with a different one.
      onDiagnostic(`the start-up failure could not be shown: ${describeFatal(error)}`);
    }
  }

  onDiagnostic(
    shownToUser
      ? 'start-up failed; the reader was told and the application is closing'
      : 'start-up failed before a window could be shown; the application is closing with no visible message',
  );

  terminate(FATAL_EXIT_CODE);

  return { shownToUser };
};
