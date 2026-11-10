import { describe, expect, it, vi } from 'vitest';

import {
  BOOTSTRAP_FAILURE_BODY,
  BOOTSTRAP_FAILURE_TITLE,
  describeFatal,
  FATAL_EXIT_CODE,
  installProcessGuards,
  RENDERER_LOST_BODY,
  RENDERER_LOST_TITLE,
  reportBootstrapFailure,
  reportTerminalRendererLoss,
} from './processGuards';

/**
 * The main process's last resort (M7.1, ADR-035, M7 investigation R9).
 *
 * The handlers are registered on an injected target rather than on the
 * real `process`, because a test that installs a real
 * `uncaughtException` handler changes the behaviour of every test that
 * runs after it in the same worker.
 */

/** A stand-in for `process` that lets a test fire the events. */
const target = (): {
  readonly on: (event: string, handler: (value: unknown) => void) => void;
  readonly fire: (event: string, value: unknown) => void;
  readonly events: () => string[];
} => {
  const handlers = new Map<string, ((value: unknown) => void)[]>();

  return {
    on: (event, handler): void => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    fire: (event, value): void => {
      for (const handler of handlers.get(event) ?? []) {
        handler(value);
      }
    },
    events: () => [...handlers.keys()].sort(),
  };
};

describe('the last-resort handlers', () => {
  it('registers for both events and nothing else', () => {
    const process = target();

    installProcessGuards({
      onDiagnostic: vi.fn(),
      terminate: vi.fn(),
      target: process as unknown as NodeJS.Process,
    });

    expect(process.events()).toStrictEqual(['uncaughtException', 'unhandledRejection']);
  });

  it('records an uncaught exception and ends the process honestly', () => {
    const process = target();
    const log: string[] = [];
    const terminate = vi.fn();

    const guards = installProcessGuards({
      onDiagnostic: (message) => log.push(message),
      terminate,
      target: process as unknown as NodeJS.Process,
    });

    process.fire('uncaughtException', new Error('the roof fell in'));

    expect(log).toHaveLength(1);
    expect(log[0]).toContain('unhandled exception');
    expect(log[0]).toContain('the roof fell in');
    expect(terminate).toHaveBeenCalledWith(FATAL_EXIT_CODE);
    expect(guards.tripped()).toBe(true);
  });

  it('records an unhandled rejection the same way', () => {
    const process = target();
    const log: string[] = [];
    const terminate = vi.fn();

    installProcessGuards({
      onDiagnostic: (message) => log.push(message),
      terminate,
      target: process as unknown as NodeJS.Process,
    });

    process.fire('unhandledRejection', new Error('nobody caught me'));

    expect(log[0]).toContain('unhandled promise rejection');
    expect(terminate).toHaveBeenCalledWith(FATAL_EXIT_CODE);
  });

  it('does not keep a broken process alive: the exit is not optional', () => {
    const process = target();
    const terminate = vi.fn();

    installProcessGuards({
      onDiagnostic: vi.fn(),
      terminate,
      target: process as unknown as NodeJS.Process,
    });

    process.fire('uncaughtException', new Error('fatal'));

    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('handles the first event only: a second one is not a second exit', () => {
    const process = target();
    const log: string[] = [];
    const terminate = vi.fn();

    installProcessGuards({
      onDiagnostic: (message) => log.push(message),
      terminate,
      target: process as unknown as NodeJS.Process,
    });

    process.fire('uncaughtException', new Error('first'));
    process.fire('uncaughtException', new Error('second'));
    process.fire('unhandledRejection', 'third');

    expect(log).toHaveLength(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('still exits when the logger itself throws', () => {
    const process = target();
    const terminate = vi.fn();

    installProcessGuards({
      onDiagnostic: () => {
        throw new Error('the log is broken too');
      },
      terminate,
      target: process as unknown as NodeJS.Process,
    });

    expect(() => process.fire('uncaughtException', new Error('fatal'))).not.toThrow();
    expect(terminate).toHaveBeenCalledWith(FATAL_EXIT_CODE);
  });

  it('describes a thrown non-error without pretending it is one', () => {
    expect(describeFatal('a bare string')).toBe('a bare string');
    expect(describeFatal(null)).toBe('null');
    expect(describeFatal(new Error('with a stack'))).toContain('with a stack');
  });
});

describe('a bootstrap that threw', () => {
  it('shows the native box when a window could be drawn, and says so', () => {
    const shown: { title: string; content: string }[] = [];
    const log: string[] = [];
    const terminate = vi.fn();

    const result = reportBootstrapFailure({
      onDiagnostic: (message) => log.push(message),
      showErrorBox: (title, content) => shown.push({ title, content }),
      terminate,
    });

    expect(result.shownToUser).toBe(true);
    expect(shown).toStrictEqual([
      { title: BOOTSTRAP_FAILURE_TITLE, content: BOOTSTRAP_FAILURE_BODY },
    ]);
    expect(log[0]).toContain('the reader was told');
    expect(terminate).toHaveBeenCalledWith(FATAL_EXIT_CODE);
  });

  it('does not claim to have shown anything when it could not', () => {
    const log: string[] = [];
    const terminate = vi.fn();

    const result = reportBootstrapFailure({
      onDiagnostic: (message) => log.push(message),
      showErrorBox: null,
      terminate,
    });

    expect(result.shownToUser).toBe(false);
    expect(log[0]).toContain('no visible message');
    expect(terminate).toHaveBeenCalledWith(FATAL_EXIT_CODE);
  });

  it('exits anyway when the box itself fails, and reports both', () => {
    const log: string[] = [];
    const terminate = vi.fn();

    const result = reportBootstrapFailure({
      onDiagnostic: (message) => log.push(message),
      showErrorBox: () => {
        throw new Error('no display');
      },
      terminate,
    });

    expect(result.shownToUser).toBe(false);
    expect(log[0]).toContain('could not be shown');
    expect(log[1]).toContain('no visible message');
    expect(terminate).toHaveBeenCalledWith(FATAL_EXIT_CODE);
  });

  it('never bootstraps again: it only reports and ends', () => {
    const terminate = vi.fn();

    reportBootstrapFailure({
      onDiagnostic: vi.fn(),
      showErrorBox: vi.fn(),
      terminate,
    });

    expect(terminate).toHaveBeenCalledTimes(1);
  });
});

describe('the two strings a reader can see without a renderer', () => {
  it('carry no path, no errno and no exception text', () => {
    for (const copy of [
      BOOTSTRAP_FAILURE_TITLE,
      BOOTSTRAP_FAILURE_BODY,
      RENDERER_LOST_TITLE,
      RENDERER_LOST_BODY,
    ]) {
      expect(copy).not.toMatch(/[\\/]/u);
      expect(copy).not.toMatch(/E[A-Z]{3,}/u);
      expect(copy).not.toMatch(/Error|exception|stack|exit code/iu);
    }
  });

  it('tell the reader what to do rather than what broke', () => {
    expect(BOOTSTRAP_FAILURE_BODY).toContain('Starting it again');
    expect(RENDERER_LOST_BODY).toContain('open it again');
  });
});

describe('the terminal renderer loss (M7.1 audit condition C-1)', () => {
  /**
   * Records the order in which the two steps happen.
   *
   * The ordering is the behaviour under test, not a detail of it:
   * `dialog.showErrorBox` blocks until the reader dismisses it, so a
   * window destroyed *after* the box is a window left painted on screen
   * for the whole time the box is up. The audit photographed exactly
   * that. Asserting \'both were called\' would pass against the defect;
   * only the sequence distinguishes them.
   */
  const recordSequence = (): {
    sequence: string[];
    report: () => void;
  } => {
    const sequence: string[] = [];

    return {
      sequence,
      report: (): void =>
        reportTerminalRendererLoss({
          destroyWindow: () => sequence.push('destroy'),
          showErrorBox: (title, content) => sequence.push(`show:${title}|${content.slice(0, 16)}`),
          onDiagnostic: (message) => sequence.push(`log:${message}`),
        }),
    };
  };

  it('destroys the dead window BEFORE the blocking box is shown', () => {
    const { sequence, report } = recordSequence();

    report();

    const destroyedAt = sequence.indexOf('destroy');
    const shownAt = sequence.findIndex((step) => step.startsWith('show:'));

    expect(destroyedAt).toBe(0);
    expect(shownAt).toBeGreaterThan(destroyedAt);
  });

  it('records that the window is gone before it blocks on the box', () => {
    const { sequence, report } = recordSequence();

    report();

    const loggedAt = sequence.findIndex((step) =>
      step.startsWith('log:the dead reader window has'),
    );
    const shownAt = sequence.findIndex((step) => step.startsWith('show:'));

    expect(loggedAt).toBeGreaterThanOrEqual(0);
    expect(shownAt).toBeGreaterThan(loggedAt);
  });

  it('does exactly one of each: no retry, no second box, no reload', () => {
    const { sequence, report } = recordSequence();

    report();

    expect(sequence.filter((step) => step === 'destroy')).toHaveLength(1);
    expect(sequence.filter((step) => step.startsWith('show:'))).toHaveLength(1);
  });

  it('shows the unchanged fixed copy', () => {
    const shown: [string, string][] = [];

    reportTerminalRendererLoss({
      destroyWindow: () => undefined,
      showErrorBox: (title, content) => void shown.push([title, content]),
      onDiagnostic: () => undefined,
    });

    expect(shown).toEqual([[RENDERER_LOST_TITLE, RENDERER_LOST_BODY]]);
    expect(RENDERER_LOST_TITLE).toBe('The reader stopped');
    expect(RENDERER_LOST_BODY).toContain('could not be restarted');
    expect(RENDERER_LOST_BODY).toContain('unaffected');
  });

  it('still tells the reader when the window refuses to close', () => {
    const sequence: string[] = [];

    expect(() =>
      reportTerminalRendererLoss({
        destroyWindow: () => {
          throw new Error('the window handle has gone');
        },
        showErrorBox: () => sequence.push('show'),
        onDiagnostic: (message) => sequence.push(`log:${message}`),
      }),
    ).not.toThrow();

    expect(sequence.some((step) => step.includes('could not be closed'))).toBe(true);
    expect(sequence).toContain('show');
    // The failure to close is reported before the blocking box, too.
    expect(sequence.indexOf('show')).toBe(sequence.length - 1);
  });

  it('leaks nothing about the window or the crash into the box', () => {
    const shown: string[] = [];

    reportTerminalRendererLoss({
      destroyWindow: () => undefined,
      showErrorBox: (title, content) => void shown.push(`${title} ${content}`),
      onDiagnostic: () => undefined,
    });

    for (const text of shown) {
      expect(text).not.toMatch(/[\\/]/u);
      expect(text).not.toMatch(/exitCode|reason=|crash|render/iu);
    }
  });
});

/**
 * M7.1 audit finding CF-1.
 *
 * The C-1 remediation logged the closure of the dead window
 * unconditionally, so the failure path printed both "could not be
 * closed" and, one line later, "has been closed". The main-process
 * evidence contradicted itself, and anything reading the log — the
 * runtime recovery harness included — could infer a destruction that
 * never happened from a phrase that does not prove it.
 *
 * These tests pin the claim to the fact. They are deliberately separate
 * from the C-1 ordering tests above, which are unchanged: ordering and
 * truthfulness are two different invariants and each should be able to
 * fail on its own.
 */
describe('the terminal renderer loss reports the closure it actually achieved (CF-1)', () => {
  const run = (
    destroyWindow: () => void,
  ): { steps: string[]; diagnostics: string[]; boxes: [string, string][] } => {
    const steps: string[] = [];
    const diagnostics: string[] = [];
    const boxes: [string, string][] = [];

    reportTerminalRendererLoss({
      destroyWindow: () => {
        steps.push('destroy');
        destroyWindow();
      },
      showErrorBox: (title, content) => {
        steps.push('show');
        boxes.push([title, content]);
      },
      onDiagnostic: (message) => {
        steps.push('log');
        diagnostics.push(message);
      },
    });

    return { steps, diagnostics, boxes };
  };

  const explode = (): never => {
    throw new Error('the window handle has gone');
  };

  describe('when the window closes', () => {
    it('destroys exactly once, says it closed, then shows the box', () => {
      const { steps, diagnostics, boxes } = run(() => undefined);

      expect(steps).toEqual(['destroy', 'log', 'show']);
      expect(diagnostics).toEqual([
        'the dead reader window has been closed; showing the terminal message',
      ]);
      expect(boxes).toEqual([[RENDERER_LOST_TITLE, RENDERER_LOST_BODY]]);
    });

    it('does not claim a failure that did not happen', () => {
      const { diagnostics } = run(() => undefined);

      expect(diagnostics.join('\n')).not.toContain('could not be closed');
      expect(diagnostics.join('\n')).not.toContain('still open');
    });
  });

  describe('when the window refuses to close', () => {
    it('never claims the window has been closed', () => {
      const { diagnostics } = run(explode);

      expect(diagnostics.join('\n')).not.toContain('has been closed');
    });

    it('records the failure with the safe fatal description and no more', () => {
      const { diagnostics } = run(explode);

      expect(diagnostics[0]).toContain(
        'the dead reader window could not be closed: Error: the window handle has gone',
      );
      expect(diagnostics[1]).toBe(
        'the dead reader window is still open; showing the terminal message anyway',
      );
      expect(diagnostics).toHaveLength(2);
    });

    it('still shows the same fixed box, last of all', () => {
      const { steps, boxes } = run(explode);

      expect(boxes).toEqual([[RENDERER_LOST_TITLE, RENDERER_LOST_BODY]]);
      expect(steps.indexOf('show')).toBe(steps.length - 1);
      expect(steps.indexOf('show')).toBeGreaterThan(steps.indexOf('destroy'));
    });

    it('does not retry the destroy and opens no second box', () => {
      const { steps } = run(explode);

      expect(steps.filter((step) => step === 'destroy')).toHaveLength(1);
      expect(steps.filter((step) => step === 'show')).toHaveLength(1);
    });

    it('does not propagate the failure to the caller', () => {
      expect(() => run(explode)).not.toThrow();
    });

    it('keeps the failure out of anything the reader can see', () => {
      const { boxes } = run(explode);

      for (const [title, body] of boxes) {
        const text = `${title} ${body}`;

        expect(text).not.toContain('window handle');
        expect(text).not.toContain('Error');
        expect(text).not.toContain('has been closed');
        expect(text).not.toContain('still open');
      }
    });
  });
});
