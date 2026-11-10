import type { ReactElement, ReactNode } from 'react';

/**
 * The one way this application tells the reader what is happening.
 *
 * Before 6.5 the same four situations were dressed four different ways
 * (investigation I5, I6): three status idioms across the shell, the library
 * and the popup, two different error colours, and a `role` chosen afresh at
 * every call site — which is how `.reader__message` came to paint a neutral
 * "no text layer" notice in the failure colour, and how a failure could end
 * up announced as a polite `status` while a mere notice shouted as an
 * `alert`.
 *
 * The component is deliberately tiny: it is a paragraph, a class and the
 * live-region decision. It owns no state, no timers, no portal and no
 * dismissal; the undo bar keeps its own behaviour (an M4 invariant) and
 * only borrows the styling. There is no toast system here and no event bus
 * — a message is rendered by whoever is in a position to know about it,
 * exactly as before.
 *
 * ST-2: `busy` and `info` are polite `status`; `problem` is an `alert`;
 * never both, and never two live regions for one event.
 */

export type MessageKind =
  /** Something neutral the reader should know. Announced politely. */
  | 'info'
  /** Work is in progress. Announced politely. */
  | 'busy'
  /** Something failed. Announced assertively. */
  | 'problem'
  /** There is nothing here yet. Not announced: it is the content. */
  | 'empty';

const ROLES: Record<MessageKind, 'status' | 'alert' | undefined> = {
  info: 'status',
  busy: 'status',
  problem: 'alert',
  empty: undefined,
};

/*
  Written out rather than composed from the kind, so that every class this
  component can put in the DOM appears literally in a renderer source. The
  stylesheet tests read these files to decide whether a rule still has a
  user; a template literal would hide `message--problem` from them and the
  rule would be reported as dead.
*/
const CLASSES: Record<MessageKind, string> = {
  info: 'message message--info',
  busy: 'message message--busy',
  problem: 'message message--problem',
  empty: 'message message--empty',
};

export interface MessageProps {
  readonly kind: MessageKind;
  readonly children: ReactNode;
  /** Forwarded as `data-testid`; omitted entirely when not given. */
  readonly testId?: string;
  /** Layout only — a surface positioning its own message. Never colour. */
  readonly className?: string;
  /**
   * Set `false` only where an existing live region already announces this
   * state. The dictionary popup is the one case: it keeps a single
   * `role="status"` node for the whole lookup (6.2, A11Y-8), so the
   * visible "could not be loaded" line beside it must stay silent rather
   * than say the same thing twice.
   */
  readonly announce?: boolean;
}

export const Message = ({
  kind,
  children,
  testId,
  className,
  announce = true,
}: MessageProps): ReactElement => (
  <p
    className={className === undefined ? CLASSES[kind] : `${CLASSES[kind]} ${className}`}
    role={announce ? ROLES[kind] : undefined}
    data-testid={testId}
  >
    {children}
  </p>
);
