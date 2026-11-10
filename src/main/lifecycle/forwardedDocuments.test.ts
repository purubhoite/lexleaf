import { describe, expect, it, vi } from 'vitest';

import {
  createForwardedDocumentQueue,
  DEFAULT_FORWARD_QUEUE_DEPTH,
  type ForwardedDocumentQueue,
} from './forwardedDocuments';

const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/**
 * C-1. The queue is driven exactly as the main process drives it: a
 * delivery points the existing `initialDocument` answer at a path and
 * reloads, and the renderer's own request for that document is what
 * completes it. Nothing here waits on a clock.
 */
interface Harness {
  readonly queue: ForwardedDocumentQueue;
  /** Paths handed to the open path, in the order they were handed over. */
  readonly delivered: string[];
  /** What `initialDocument` would currently answer with. */
  requested: string | null;
  /** Paths the renderer actually opened, in order. */
  readonly opened: string[];
  readonly log: string[];
  /** Completes a delivery the way the real handler does. */
  rendererAsks(): void;
  /** Lets a delivery resolve when deliveries are held open. */
  releaseDelivery(): void;
  fireTimer(): void;
}

const build = ({ holdDelivery = false }: { holdDelivery?: boolean } = {}): Harness => {
  const delivered: string[] = [];
  const opened: string[] = [];
  const log: string[] = [];
  let requested: string | null = null;
  let releaseDelivery = (): void => undefined;
  let timer: (() => void) | null = null;

  const queue = createForwardedDocumentQueue({
    deliver: async (path) => {
      delivered.push(path);
      requested = path;

      if (holdDelivery) {
        await new Promise<void>((resolve) => {
          releaseDelivery = resolve;
        });
      }
    },
    onDiagnostic: (message) => log.push(message),
    setTimer: (handler) => {
      timer = handler;

      return 'handle';
    },
    clearTimer: () => undefined,
  });

  const harness: Harness = {
    queue,
    delivered,
    opened,
    log,
    get requested(): string | null {
      return requested;
    },
    set requested(value: string | null) {
      requested = value;
    },
    rendererAsks(): void {
      // Exactly the shape of the real handler: ticket, open, complete.
      const ticket = queue.beginInitialDocumentRequest();

      if (requested !== null) {
        opened.push(requested);
      }

      queue.completeInitialDocumentRequest(ticket);
    },
    releaseDelivery(): void {
      releaseDelivery();
    },
    fireTimer(): void {
      timer?.();
    },
  };

  return harness;
};

describe('forwarded documents are opened one at a time (C-1)', () => {
  it('reproduces the audit burst: four launches back to back, four documents opened, in order', async () => {
    const harness = build();
    const paths = ['/one.pdf', '/two.pdf', '/three.pdf', '/four.pdf'];

    // Issued with nothing in between — the exact shape of the failure.
    for (const path of paths) {
      harness.queue.enqueue(path);
    }

    await tick();

    // Only the first may have been handed over so far.
    expect(harness.delivered).toEqual(['/one.pdf']);

    for (const path of paths) {
      expect(harness.queue.inFlight()).toBe(path);
      harness.rendererAsks();
      await tick();
    }

    expect(harness.delivered).toEqual(paths);
    expect(harness.opened).toEqual(paths);
    expect(harness.queue.depth()).toBe(0);
    expect(harness.queue.inFlight()).toBeNull();
    expect(harness.log).toEqual([]);
  });

  it('does not hand over the next document until the previous one has been consumed', async () => {
    const harness = build();

    harness.queue.enqueue('/first.pdf');
    harness.queue.enqueue('/second.pdf');
    await tick();

    expect(harness.delivered).toEqual(['/first.pdf']);
    expect(harness.requested).toBe('/first.pdf');
    expect(harness.queue.depth()).toBe(1);

    // Any amount of waiting, on its own, must change nothing.
    await tick();
    await tick();
    expect(harness.delivered).toEqual(['/first.pdf']);

    harness.rendererAsks();
    await tick();

    expect(harness.delivered).toEqual(['/first.pdf', '/second.pdf']);
    expect(harness.opened).toEqual(['/first.pdf']);
  });

  it('ignores a request the renderer began before the delivery', async () => {
    const harness = build();

    // The start-up request, in flight before anything was forwarded.
    const stale = harness.queue.beginInitialDocumentRequest();

    harness.queue.enqueue('/first.pdf');
    harness.queue.enqueue('/second.pdf');
    await tick();

    harness.queue.completeInitialDocumentRequest(stale);
    await tick();

    // The stale answer was about the previous document, so it completes
    // nothing: /second.pdf must still be waiting.
    expect(harness.delivered).toEqual(['/first.pdf']);
    expect(harness.queue.depth()).toBe(1);

    harness.rendererAsks();
    await tick();

    expect(harness.delivered).toEqual(['/first.pdf', '/second.pdf']);
  });

  it('a start-up request with nothing in flight completes nothing', async () => {
    const harness = build();

    harness.requested = '/launched-with.pdf';
    harness.rendererAsks();
    await tick();

    expect(harness.queue.inFlight()).toBeNull();
    expect(harness.delivered).toEqual([]);
    expect(harness.opened).toEqual(['/launched-with.pdf']);
  });

  it('keeps order even when a delivery itself takes a while', async () => {
    const harness = build({ holdDelivery: true });

    harness.queue.enqueue('/a.pdf');
    harness.queue.enqueue('/b.pdf');
    await tick();

    expect(harness.delivered).toEqual(['/a.pdf']);

    // Completing before the delivery has even finished must not run two
    // deliveries at once.
    harness.rendererAsks();
    await tick();
    expect(harness.delivered).toEqual(['/a.pdf']);

    harness.releaseDelivery();
    await tick();
    await tick();

    expect(harness.delivered).toEqual(['/a.pdf', '/b.pdf']);
  });

  it('spaced requests behave exactly as they did before', async () => {
    const harness = build();

    harness.queue.enqueue('/one.pdf');
    await tick();
    harness.rendererAsks();
    await tick();

    harness.queue.enqueue('/two.pdf');
    await tick();
    harness.rendererAsks();
    await tick();

    expect(harness.delivered).toEqual(['/one.pdf', '/two.pdf']);
    expect(harness.opened).toEqual(['/one.pdf', '/two.pdf']);
  });

  it('a renderer that never comes back does not strand the documents behind it', async () => {
    const harness = build();

    harness.queue.enqueue('/lost.pdf');
    harness.queue.enqueue('/next.pdf');
    await tick();

    expect(harness.delivered).toEqual(['/lost.pdf']);

    // The safety net, which is not how the queue ordinarily advances.
    harness.fireTimer();
    await tick();

    expect(harness.delivered).toEqual(['/lost.pdf', '/next.pdf']);
    expect(harness.log.join()).toContain('did not ask for /lost.pdf in time');
  });

  it('refuses out loud rather than dropping a document silently', async () => {
    const harness = build();

    // One is taken for delivery immediately, the queue then fills, and
    // everything past the bound is refused with a diagnostic.
    const total = DEFAULT_FORWARD_QUEUE_DEPTH + 3;

    for (let i = 0; i < total; i += 1) {
      harness.queue.enqueue(`/doc-${String(i)}.pdf`);
    }

    await tick();

    expect(harness.queue.depth()).toBe(DEFAULT_FORWARD_QUEUE_DEPTH);
    expect(harness.log.filter((line) => line.includes('was not accepted'))).toHaveLength(
      total - DEFAULT_FORWARD_QUEUE_DEPTH - 1,
    );
  });

  it('never runs two deliveries concurrently', async () => {
    let concurrent = 0;
    let peak = 0;
    const deliver = vi.fn(async (path: string) => {
      void path;
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await Promise.resolve();
      concurrent -= 1;
    });

    const queue = createForwardedDocumentQueue({
      deliver,
      onDiagnostic: () => undefined,
    });

    for (const path of ['/a.pdf', '/b.pdf', '/c.pdf']) {
      queue.enqueue(path);
    }

    await tick();

    expect(peak).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
