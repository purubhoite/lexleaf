import { parseDocumentArgument } from '../documents/initialDocument';

/**
 * Who owns the reader state (M7.3, R4).
 *
 * The application is single-writer by design (ADR-016): one process owns
 * `reader-state.json` and rewrites it whole. Nothing enforced that before
 * M7.3, so a second launch produced a second writer, and the two
 * overwrote each other's recents, positions and preferences — last writer
 * wins, silently.
 *
 * The enforcement is Electron's own `requestSingleInstanceLock`, and
 * deliberately nothing else. No lock file (which outlives a crash and
 * needs its own staleness story), no socket, no port, no handshake
 * between processes: those are the mechanisms this slice was told not to
 * invent, and Electron already runs the only one that is tied to the
 * lifetime of the process holding it.
 *
 * The loser does not open a window and does not write state. It hands its
 * command line to the owner through `second-instance` and exits, so an
 * document named by a file manager or a terminal still reaches a
 * reader — the running one.
 *
 * Everything the function touches is injected, so the whole protocol is
 * unit tested without a second process.
 */

export interface SingleInstanceApp {
  /** Electron's own lock. `true` for the first process, `false` after. */
  requestSingleInstanceLock(): boolean;
  on(
    event: 'second-instance',
    handler: (event: unknown, argv: string[], workingDirectory: string) => void,
  ): void;
  quit(): void;
}

export interface SingleInstanceOptions {
  readonly app: SingleInstanceApp;
  /**
   * A later launch named a document. The owner is expected to open it
   * through the path it already uses for a document named on its own
   * command line — not through a second loading mechanism.
   */
  readonly onForwardedDocument: (path: string) => void;
  /** A later launch named nothing: the reader just wants the window. */
  readonly onFocusRequested: () => void;
  readonly onDiagnostic: (message: string) => void;
}

export interface SingleInstanceClaim {
  /** `false` means: do not bootstrap, do not open a window, do not write. */
  readonly isOwner: boolean;
}

export const claimSingleInstance = ({
  app,
  onForwardedDocument,
  onFocusRequested,
  onDiagnostic,
}: SingleInstanceOptions): SingleInstanceClaim => {
  if (!app.requestSingleInstanceLock()) {
    /*
     * Not an error, and not reported to anyone: opening a second copy is
     * an ordinary thing to do and the reader gets what they asked for,
     * in the window that is already open. This process has not created a
     * window, has not loaded state and will not write any.
     */
    onDiagnostic(
      'another copy of the reader already owns the reading state; handing over and exiting',
    );
    app.quit();

    return { isOwner: false };
  }

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const requested = parseDocumentArgument(argv, workingDirectory);

    if (requested === null) {
      onDiagnostic('a second copy was started without a document; focusing the existing window');
      onFocusRequested();

      return;
    }

    /*
     * The path is logged here, in the main process, and nowhere else —
     * the same rule the open pipeline itself follows (ADR-034).
     */
    onDiagnostic(`a second copy asked for ${requested}; opening it in the existing window`);
    onForwardedDocument(requested);
  });

  return { isOwner: true };
};
