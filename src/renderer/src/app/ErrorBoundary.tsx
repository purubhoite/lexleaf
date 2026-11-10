import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Message } from '../ui/Message';

/**
 * The one error boundary in the application (M7.1, ADR-035, M7
 * investigation R5).
 *
 * React's documented behaviour for an exception thrown during render is
 * to unmount the whole tree, which in this application means the window
 * goes white and stays white. There is no `window.onerror` to catch it
 * and nothing on screen to act on — the same no-way-out property as a
 * crashed renderer, reached by a different route.
 *
 * It is a class because `getDerivedStateFromError` and `componentDidCatch`
 * have no hook equivalent; this is the single exception to the function
 * components the rest of the renderer is built from, and it exists for
 * that one reason.
 *
 * What it renders is the product's own failure surface: the 6.5
 * `Message` in its `problem` kind and a `control` button, so it is
 * painted, announced, themed and focus-ringed exactly like every other
 * failure. No portal, no overlay, no second notification system, and —
 * the point of the whole exercise — no exception text.
 *
 * **The bound.** A boundary with a reset button is a loop waiting to
 * happen: a component that throws on every render will throw again the
 * moment it is remounted, and a reader can sit there pressing the button
 * for ever.
 *
 * ```
 *   healthy ──render throws──▶ failed ──reader presses "Reload the reader"──▶ healthy
 *                                 ▲                                              │
 *                                 │                                  throws again│
 *                                 └──────────────── terminal ◀───────────────────┘
 * ```
 *
 * - **failed** offers the recovery affordance, once.
 * - **terminal** does not offer it at all. There is nothing to press, so
 *   there is no loop to be in, and the message says plainly that the
 *   application has to be restarted.
 * - A reset that *works* — the tree renders again without throwing —
 *   returns the boundary to `healthy` and gives the attempt back, because
 *   an error the reader recovered from an hour ago should not condemn the
 *   next one. Nothing here ever reloads by itself: every transition out
 *   of `failed` is something the reader did.
 */

/** Copy for the two states. Fixed strings: nothing is interpolated. */
export const BOUNDARY_FAILURE_MESSAGE =
  'Something went wrong and this part of the reader stopped working. ' +
  'Your saved words and your place in the document have not been affected.';

export const BOUNDARY_TERMINAL_MESSAGE =
  'The reader could not recover. Please close the application and open it again. ' +
  'Your saved words and your place in the document have not been affected.';

/** The name of the recovery affordance, fixed so a test can ask for it. */
export const RELOAD_LABEL = 'Reload the reader';

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /**
   * Where the exception is recorded. The renderer's console by default,
   * which is where a developer looks; it is injected so a test can prove
   * the boundary reports rather than swallows.
   */
  readonly onError?: (error: unknown, componentStack: string | null) => void;
}

type BoundaryPhase = 'healthy' | 'failed' | 'terminal';

interface ErrorBoundaryState {
  readonly phase: BoundaryPhase;
  /**
   * True between a reset and the first successful render after it. It is
   * how a reset that immediately throws again is told apart from a fresh
   * failure much later.
   */
  readonly recovering: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { phase: 'healthy', recovering: false };

  /**
   * One failure shows the boundary; a failure *during* a recovery attempt
   * is terminal. The error itself is not put in state: nothing renders
   * it, so keeping it would only be a way for it to escape later.
   */
  public static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { phase: 'failed' };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState((current) => ({
      phase: current.recovering ? 'terminal' : 'failed',
      recovering: false,
    }));

    const report = this.props.onError;

    if (report === undefined) {
      // eslint-disable-next-line no-console -- the renderer's own log is where a developer looks
      console.error('[renderer] a component failed to render', error, info.componentStack);
      return;
    }

    report(error, info.componentStack ?? null);
  }

  /**
   * A recovery that held. The children rendered after a reset without
   * throwing, so the attempt is given back.
   */
  public override componentDidUpdate(): void {
    if (this.state.recovering && this.state.phase === 'healthy') {
      this.setState({ phase: 'healthy', recovering: false });
    }
  }

  private readonly reset = (): void => {
    this.setState({ phase: 'healthy', recovering: true });
  };

  public override render(): ReactNode {
    const { phase } = this.state;

    if (phase === 'healthy') {
      return this.props.children;
    }

    const terminal = phase === 'terminal';

    return (
      /*
        Existing classes only, so this adds no stylesheet rule and no new
        presentation: `.shell` is the application frame and `.start` is
        the centred surface the "document could not be opened" screen
        already uses. Theme and reduced motion therefore apply to it the
        way they apply to everything else, through the tokens and the
        root attributes, with nothing to keep in step.
      */
      <div className="shell" data-testid="error-boundary">
        <section className="start" aria-label="The reader needs attention">
          <Message kind="problem">
            {terminal ? BOUNDARY_TERMINAL_MESSAGE : BOUNDARY_FAILURE_MESSAGE}
          </Message>
          {/*
            Offered once. In the terminal state there is deliberately no
            button at all: an affordance that cannot work is worse than
            none, and its absence is what makes a loop impossible.
          */}
          {!terminal && (
            <button type="button" className="control" onClick={this.reset}>
              {RELOAD_LABEL}
            </button>
          )}
        </section>
      </div>
    );
  }
}
