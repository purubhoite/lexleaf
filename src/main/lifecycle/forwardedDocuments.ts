/**
 * Documents forwarded by later launches, one at a time (M7.3, C-1).
 *
 * M7.3 answered a `second-instance` handover by pointing the owner's
 * `initialDocument` answer at the new path and reloading the one window.
 * With one slot and no serialization that is a race: two launches close
 * together overwrite the slot before the renderer has asked for the first
 * one, and the first document is never opened at all. The closure audit
 * reproduced it — four launches in a burst, three documents in recents,
 * nothing logged, nothing shown to the reader.
 *
 * The fix is a queue, not a new mechanism. Requests are delivered in
 * arrival order, and the next one is not delivered until the previous one
 * has actually been *consumed* by the pipeline that already opens
 * documents: the existing `initialDocument` request the renderer makes
 * after the reload. That request is the completion signal, so the
 * serialization costs no IPC channel, no renderer API and no handshake of
 * our own.
 *
 * Consumption is identified by ticket rather than by timing. A request
 * that the renderer began *before* this delivery cannot complete it: it
 * was asking about the previous document and its answer says nothing
 * about this one. Only a ticket issued after the delivery counts, which
 * is what makes the queue deterministic rather than delay-tuned.
 *
 * The timeout below is a safety net and deliberately not the mechanism: a
 * renderer that dies between the reload and the request would otherwise
 * strand every later document behind it for ever.
 */

export type ForwardedDocumentTicket = number;

export interface ForwardedDocumentQueueOptions {
  /**
   * Hands one request to the existing open path: flush, point
   * `initialDocument` at the new path, reveal and reload the window.
   * Resolving means "delivered", not "opened" — opening is what the
   * renderer's own request does, and that is what completes it.
   */
  readonly deliver: (path: string) => Promise<void>;
  readonly onDiagnostic: (message: string) => void;
  /**
   * How many requests may wait. A reader cannot start launches faster
   * than this for any honest reason, and an unbounded queue in the
   * process that owns the reading state is not something to invent.
   */
  readonly maxDepth?: number;
  /** Safety net only; see the note above. */
  readonly consumptionTimeoutMs?: number;
  readonly setTimer?: (handler: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface ForwardedDocumentQueue {
  /** A later launch named a document. Queued, never dropped silently. */
  enqueue(path: string): void;
  /**
   * Called at the top of the existing `initialDocument` handler. The
   * ticket records *when* the renderer started asking.
   */
  beginInitialDocumentRequest(): ForwardedDocumentTicket;
  /** Called once that handler has finished opening the document. */
  completeInitialDocumentRequest(ticket: ForwardedDocumentTicket): void;
  /** The request currently being delivered, if any. */
  inFlight(): string | null;
  /** How many requests are still waiting behind it. */
  depth(): number;
}

export const DEFAULT_FORWARD_QUEUE_DEPTH = 32;
export const DEFAULT_CONSUMPTION_TIMEOUT_MS = 15_000;

export const createForwardedDocumentQueue = ({
  deliver,
  onDiagnostic,
  maxDepth = DEFAULT_FORWARD_QUEUE_DEPTH,
  consumptionTimeoutMs = DEFAULT_CONSUMPTION_TIMEOUT_MS,
  setTimer = (handler, ms): unknown => setTimeout(handler, ms),
  clearTimer = (handle): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
}: ForwardedDocumentQueueOptions): ForwardedDocumentQueue => {
  const waiting: string[] = [];

  let current: string | null = null;
  let tickets = 0;
  /** Tickets at or below this were issued before the current delivery. */
  let ticketFloor = 0;
  let resolveConsumption: (() => void) | null = null;
  /**
   * Set when the completion arrives before the delivery promise has
   * settled — `openMainWindow` resolves after the window has loaded, so
   * the renderer can legitimately have asked already. Without this the
   * completion would be dropped and the queue would wait on the safety
   * net for something that has already happened.
   */
  let consumed = false;
  let pumping = false;

  const settleCurrent = (): void => {
    const resolve = resolveConsumption;

    resolveConsumption = null;
    consumed = true;

    if (resolve !== null) {
      resolve();
    }
  };

  const awaitConsumption = async (path: string): Promise<void> => {
    if (consumed) {
      return;
    }

    await new Promise<void>((resolve) => {
      let done = false;

      const finish = (): void => {
        if (done) {
          return;
        }

        done = true;
        clearTimer(timer);
        resolve();
      };

      const timer = setTimer(() => {
        /*
         * The renderer never came back for it. Rather than stranding
         * every later request, the queue moves on and says so.
         */
        onDiagnostic(
          `the window did not ask for ${path} in time; continuing with any other forwarded documents`,
        );
        finish();
      }, consumptionTimeoutMs);

      resolveConsumption = finish;
    });
  };

  const pump = async (): Promise<void> => {
    if (pumping) {
      return;
    }

    pumping = true;

    try {
      for (;;) {
        const next = waiting.shift();

        if (next === undefined) {
          return;
        }

        current = next;
        consumed = false;
        // Only a request the renderer begins from here on can complete it.
        ticketFloor = tickets;

        try {
          await deliver(next);
          await awaitConsumption(next);
        } finally {
          current = null;
          resolveConsumption = null;
        }
      }
    } finally {
      pumping = false;
    }
  };

  return {
    enqueue(path: string): void {
      if (waiting.length >= maxDepth) {
        /*
         * Refused out loud. Dropping a reader's document quietly is the
         * defect this queue exists to remove, so the one case it cannot
         * serve is the one case it reports.
         */
        onDiagnostic(
          `too many documents are already waiting to be opened; ${path} was not accepted`,
        );

        return;
      }

      waiting.push(path);
      void pump();
    },

    beginInitialDocumentRequest(): ForwardedDocumentTicket {
      tickets += 1;

      return tickets;
    },

    completeInitialDocumentRequest(ticket: ForwardedDocumentTicket): void {
      if (current === null || ticket <= ticketFloor) {
        /*
         * Either nothing is being delivered — the ordinary start-up
         * request — or this request predates the delivery and was asking
         * about the previous document.
         */
        return;
      }

      settleCurrent();
    },

    inFlight: (): string | null => current,
    depth: (): number => waiting.length,
  };
};
