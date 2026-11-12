import { describe, expect, it, vi } from 'vitest';

import { claimSingleInstance, type SingleInstanceApp } from './singleInstance';

/**
 * R4. The defect was not subtle: two processes, two writers, one file.
 * These tests drive the protocol without a second process, because the
 * decision ("am I the owner?") and the handover ("here is my command
 * line") are both ordinary function calls once Electron's lock is
 * injected.
 */
const createApp = (
  lockAvailable: boolean,
): SingleInstanceApp & {
  readonly quits: number[];
  fire(argv: string[]): void;
  readonly handlers: number;
} => {
  /*
   * The event name is kept, not discarded: registering the handover on
   * some other event would otherwise look identical to registering it
   * correctly, and that is exactly a defect worth catching.
   */
  const registered: {
    event: string;
    handler: (event: unknown, argv: string[], workingDirectory: string) => void;
  }[] = [];
  const quits: number[] = [];

  return {
    quits,
    get handlers(): number {
      return registered.filter((entry) => entry.event === 'second-instance').length;
    },
    requestSingleInstanceLock: (): boolean => lockAvailable,
    on: (event, handler): void => {
      registered.push({ event, handler });
    },
    quit: (): void => {
      quits.push(1);
    },
    fire: (argv): void => {
      for (const entry of registered) {
        if (entry.event === 'second-instance') {
          entry.handler({}, argv, '/home/reader');
        }
      }
    },
  };
};

describe('the single-instance claim', () => {
  it('makes the first process the owner and registers one handover handler', () => {
    const app = createApp(true);

    const claim = claimSingleInstance({
      app,
      onForwardedDocument: () => undefined,
      onFocusRequested: () => undefined,
      onDiagnostic: () => undefined,
    });

    expect(claim.isOwner).toBe(true);
    expect(app.quits).toHaveLength(0);
    expect(app.handlers).toBe(1);
  });

  it('makes a later process quit without becoming an owner', () => {
    const app = createApp(false);
    const log: string[] = [];

    const claim = claimSingleInstance({
      app,
      onForwardedDocument: () => undefined,
      onFocusRequested: () => undefined,
      onDiagnostic: (message) => log.push(message),
    });

    expect(claim.isOwner).toBe(false);
    expect(app.quits).toHaveLength(1);
    expect(log.join()).toContain('already owns the reading state');
  });

  it('does not listen for handovers when it is not the owner', () => {
    const app = createApp(false);

    claimSingleInstance({
      app,
      onForwardedDocument: () => undefined,
      onFocusRequested: () => undefined,
      onDiagnostic: () => undefined,
    });

    expect(app.handlers).toBe(0);
  });

  it('forwards a document named by a later launch', () => {
    const app = createApp(true);
    const forwarded: string[] = [];
    const focused = vi.fn();

    claimSingleInstance({
      app,
      onForwardedDocument: (path) => forwarded.push(path),
      onFocusRequested: focused,
      onDiagnostic: () => undefined,
    });

    app.fire(['electron', '.', '--open-document=/books/second.pdf']);

    expect(forwarded).toEqual(['/books/second.pdf']);
    expect(focused).not.toHaveBeenCalled();
  });

  it('asks only for focus when a later launch names no document', () => {
    const app = createApp(true);
    const forwarded: string[] = [];
    const focused = vi.fn();

    claimSingleInstance({
      app,
      onForwardedDocument: (path) => forwarded.push(path),
      onFocusRequested: focused,
      onDiagnostic: () => undefined,
    });

    app.fire(['electron', '.']);

    expect(forwarded).toEqual([]);
    expect(focused).toHaveBeenCalledTimes(1);
  });

  it('handles repeated handovers without ever creating a second owner', () => {
    const app = createApp(true);
    const forwarded: string[] = [];

    const claim = claimSingleInstance({
      app,
      onForwardedDocument: (path) => forwarded.push(path),
      onFocusRequested: () => undefined,
      onDiagnostic: () => undefined,
    });

    for (let i = 0; i < 10; i += 1) {
      app.fire(['electron', '.', `--open-document=/books/${String(i)}.pdf`]);
    }

    expect(claim.isOwner).toBe(true);
    expect(forwarded).toHaveLength(10);
    expect(forwarded.at(-1)).toBe('/books/9.pdf');
    expect(app.quits).toHaveLength(0);
    expect(app.handlers).toBe(1);
  });

  it('keeps the forwarded path in the main-process log only', () => {
    const app = createApp(true);
    const log: string[] = [];

    claimSingleInstance({
      app,
      onForwardedDocument: () => undefined,
      onFocusRequested: () => undefined,
      onDiagnostic: (message) => log.push(message),
    });

    app.fire(['electron', '.', '--open-document=/books/second.pdf']);

    // The path is a main-process diagnostic (ADR-034); this asserts where
    // it goes, not that it is secret.
    expect(log.join()).toContain('/books/second.pdf');
  });
});
