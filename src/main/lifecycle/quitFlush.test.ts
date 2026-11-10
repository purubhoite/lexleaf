import { describe, expect, it, vi } from 'vitest';

import { createQuitFlush, type QuitFlushPersistence } from './quitFlush';

/** Lets the promise chain inside the module settle. */
const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/**
 * L1. Quitting must not race the debounced write. The timer is injected
 * so the bound is asserted rather than waited for.
 */
interface Harness {
  readonly quits: number;
  readonly log: string[];
  readonly event: { prevented: number; preventDefault(): void };
  fireTimer(): void;
  readonly timerArmed: boolean;
  readonly timerCleared: boolean;
}

const build = (
  flush: () => Promise<QuitFlushPersistence>,
): { quit: ReturnType<typeof createQuitFlush>; harness: Harness } => {
  let quits = 0;
  const log: string[] = [];
  let armed: (() => void) | null = null;
  let cleared = false;
  let prevented = 0;

  const quitFlush = createQuitFlush({
    flush,
    quit: () => {
      quits += 1;
    },
    onDiagnostic: (message) => log.push(message),
    timeoutMs: 2_000,
    setTimer: (handler) => {
      armed = handler;

      return 'handle';
    },
    clearTimer: () => {
      cleared = true;
    },
  });

  const harness: Harness = {
    get quits(): number {
      return quits;
    },
    log,
    event: {
      prevented: 0,
      preventDefault(): void {
        prevented += 1;
        this.prevented = prevented;
      },
    },
    fireTimer: (): void => armed?.(),
    get timerArmed(): boolean {
      return armed !== null;
    },
    get timerCleared(): boolean {
      return cleared;
    },
  };

  return { quit: quitFlush, harness };
};

describe('flushing reading state before the process quits', () => {
  it('cancels the first quit, awaits the flush, then quits', async () => {
    let resolveFlush = (): void => undefined;
    const flush = vi.fn(
      () =>
        new Promise<QuitFlushPersistence>((resolve) => {
          resolveFlush = (): void => resolve('saved');
        }),
    );

    const { quit, harness } = build(flush);

    quit.onBeforeQuit(harness.event);

    expect(harness.event.prevented).toBe(1);
    expect(quit.phase()).toBe('flushing');
    expect(harness.quits).toBe(0);

    resolveFlush();
    await tick();

    expect(quit.phase()).toBe('done');
    expect(harness.quits).toBe(1);
    expect(harness.log.join()).toContain('flushed before quitting');
  });

  it('lets the quit it asked for through untouched', async () => {
    const { quit, harness } = build(() => Promise.resolve('saved'));

    quit.onBeforeQuit(harness.event);
    await tick();

    expect(quit.phase()).toBe('done');

    const before = harness.event.prevented;

    quit.onBeforeQuit(harness.event);

    expect(harness.event.prevented).toBe(before);
    expect(harness.quits).toBe(1);
  });

  it('quits anyway when the flush fails, and says so', async () => {
    const { quit, harness } = build(() => Promise.reject(new Error('read-only filesystem')));

    quit.onBeforeQuit(harness.event);
    await tick();

    expect(quit.phase()).toBe('done');
    expect(harness.quits).toBe(1);
    expect(harness.log.join()).toContain('could not be flushed');
    expect(harness.log.join()).not.toContain('read-only filesystem');
  });

  it('quits on the timeout when the flush never settles: shutdown is bounded', () => {
    const { quit, harness } = build(() => new Promise<QuitFlushPersistence>(() => undefined));

    quit.onBeforeQuit(harness.event);

    expect(harness.quits).toBe(0);
    expect(harness.timerArmed).toBe(true);

    harness.fireTimer();

    expect(quit.phase()).toBe('done');
    expect(harness.quits).toBe(1);
    expect(harness.log.join()).toContain('did not finish being flushed in time');
  });

  it('does not quit twice when the flush lands after the timeout', async () => {
    let resolveFlush = (): void => undefined;
    const { quit, harness } = build(
      () =>
        new Promise<QuitFlushPersistence>((resolve) => {
          resolveFlush = (): void => resolve('saved');
        }),
    );

    quit.onBeforeQuit(harness.event);
    harness.fireTimer();
    resolveFlush();
    await tick();

    expect(harness.quits).toBe(1);
    expect(harness.log).toHaveLength(1);
  });

  it('clears the safety timer when the flush wins', async () => {
    const { quit, harness } = build(() => Promise.resolve('saved'));

    quit.onBeforeQuit(harness.event);
    await tick();

    expect(harness.timerCleared).toBe(true);
  });

  /* -- C-2: the wording has to match what the disk did ---------------- */

  it('never claims the state was flushed when the write did not succeed', async () => {
    const { quit, harness } = build(() => Promise.resolve('not-saved'));

    quit.onBeforeQuit(harness.event);
    await tick();

    expect(quit.phase()).toBe('done');
    expect(harness.quits).toBe(1);
    expect(harness.log).toHaveLength(1);
    expect(harness.log[0]).toContain('could not be saved before quitting');
    expect(harness.log[0]).toContain('the last saved state is unchanged');
    expect(harness.log.join()).not.toContain('reading state was flushed before quitting');
  });

  it('still reports success when the write really did succeed', async () => {
    const { quit, harness } = build(() => Promise.resolve('saved'));

    quit.onBeforeQuit(harness.event);
    await tick();

    expect(harness.log[0]).toBe('reading state was flushed before quitting');
  });

  it('a failed write does not delay the quit beyond the successful case', async () => {
    const { quit, harness } = build(() => Promise.resolve('not-saved'));

    quit.onBeforeQuit(harness.event);
    await tick();

    // No retry, no second flush, no waiting for the safety timer.
    expect(harness.quits).toBe(1);
    expect(harness.timerCleared).toBe(true);
  });

  it('a second quit while flushing waits rather than starting another flush', () => {
    const flush = vi.fn(() => new Promise<QuitFlushPersistence>(() => undefined));
    const { quit, harness } = build(flush);

    quit.onBeforeQuit(harness.event);
    quit.onBeforeQuit(harness.event);
    quit.onBeforeQuit(harness.event);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(harness.event.prevented).toBe(3);
    expect(harness.quits).toBe(0);
  });
});
