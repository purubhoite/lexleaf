import { describe, expect, it, vi } from 'vitest';

import { createRendererRecovery, RECOVERY_STATES } from './rendererRecovery';

/**
 * The crash lifecycle (M7.1, ADR-035, M7 investigation R1).
 *
 * The thing worth testing is not that a handler exists — R1's defect was
 * the absence of one, but a handler that reloads for ever is a worse
 * application than one that does nothing. So most of what is below is
 * about the *bound*: one attempt, then an honest end, and no path back
 * out of it.
 */

const harness = (): {
  readonly recovery: ReturnType<typeof createRendererRecovery>;
  readonly reload: ReturnType<typeof vi.fn>;
  readonly terminal: ReturnType<typeof vi.fn>;
  readonly log: string[];
} => {
  const reload = vi.fn();
  const terminal = vi.fn();
  const log: string[] = [];

  return {
    reload,
    terminal,
    log,
    recovery: createRendererRecovery({
      reload,
      onTerminalFailure: terminal,
      onDiagnostic: (message) => log.push(message),
    }),
  };
};

const crashed = { reason: 'crashed', exitCode: 133 };

describe('the renderer crash lifecycle', () => {
  it('starts healthy, with nothing to tell the renderer', () => {
    const { recovery } = harness();

    expect(recovery.state()).toBe('healthy');
    expect(recovery.notice()).toBe('none');
    expect(recovery.stalled()).toBe(false);
  });

  it('reloads exactly once when the renderer dies', () => {
    const { recovery, reload, terminal } = harness();

    recovery.onRendererGone(crashed);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(terminal).not.toHaveBeenCalled();
    expect(recovery.state()).toBe('recovering');
  });

  it('tells the replacement renderer that it is a replacement', () => {
    const { recovery } = harness();

    recovery.onRendererGone(crashed);
    expect(recovery.notice()).toBe('after-crash');

    recovery.onRendererReady();
    expect(recovery.state()).toBe('recovered');
    expect(recovery.notice()).toBe('after-crash');
  });

  it('does not reload a second time when the replacement dies during recovery', () => {
    const { recovery, reload, terminal } = harness();

    recovery.onRendererGone(crashed);
    recovery.onRendererGone(crashed);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(recovery.state()).toBe('failed');
  });

  it('spends the session attempt even when the first recovery succeeded', () => {
    const { recovery, reload, terminal } = harness();

    recovery.onRendererGone(crashed);
    recovery.onRendererReady();
    recovery.onRendererGone(crashed);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(recovery.state()).toBe('failed');
  });

  it('is terminal: nothing reloads, however many more deaths arrive', () => {
    const { recovery, reload, terminal } = harness();

    recovery.onRendererGone(crashed);
    recovery.onRendererGone(crashed);
    recovery.onRendererGone(crashed);
    recovery.onRendererGone(crashed);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(recovery.state()).toBe('failed');
  });

  it('a renderer ready in a terminal session does not revive it', () => {
    const { recovery } = harness();

    recovery.onRendererGone(crashed);
    recovery.onRendererGone(crashed);
    recovery.onRendererReady();

    expect(recovery.state()).toBe('failed');
    expect(recovery.notice()).toBe('none');
  });

  it('a clean exit is not a crash: the window is closing', () => {
    const { recovery, reload, terminal } = harness();

    recovery.onRendererGone({ reason: 'clean-exit', exitCode: 0 });

    expect(reload).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
    expect(recovery.state()).toBe('healthy');
    expect(recovery.notice()).toBe('none');
  });

  it('reports every death to the log, including the ones it does not act on', () => {
    const { recovery, log } = harness();

    recovery.onRendererGone({ reason: 'clean-exit', exitCode: 0 });
    recovery.onRendererGone(crashed);
    recovery.onRendererGone(crashed);

    expect(log).toHaveLength(3);
    expect(log.join('\n')).toContain('exitCode=133');
  });

  it('an ordinary renderer ready, with no crash, says nothing', () => {
    const { recovery } = harness();

    recovery.onRendererReady();

    expect(recovery.state()).toBe('healthy');
    expect(recovery.notice()).toBe('none');
  });
});

describe('an unresponsive renderer is not a dead one', () => {
  it('records the stall without reloading anything', () => {
    const { recovery, reload, terminal, log } = harness();

    recovery.onUnresponsive();

    expect(reload).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
    expect(recovery.state()).toBe('healthy');
    expect(recovery.stalled()).toBe(true);
    expect(log).toHaveLength(1);
  });

  it('clears the stall when the renderer answers again', () => {
    const { recovery, log } = harness();

    recovery.onUnresponsive();
    recovery.onResponsive();

    expect(recovery.stalled()).toBe(false);
    expect(recovery.state()).toBe('healthy');
    expect(log).toHaveLength(2);
  });

  it('does not repeat the diagnostic while the renderer stays busy', () => {
    const { recovery, log } = harness();

    recovery.onUnresponsive();
    recovery.onUnresponsive();
    recovery.onUnresponsive();

    expect(log).toHaveLength(1);
  });

  it('a responsive event with no stall is not news', () => {
    const { recovery, log } = harness();

    recovery.onResponsive();

    expect(log).toHaveLength(0);
    expect(recovery.stalled()).toBe(false);
  });

  it('a stall that turns into a death is still only one reload', () => {
    const { recovery, reload } = harness();

    recovery.onUnresponsive();
    recovery.onRendererGone(crashed);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(recovery.stalled()).toBe(false);
  });
});

describe('the state set', () => {
  it('is the four written down, and nothing else', () => {
    expect([...RECOVERY_STATES]).toStrictEqual(['healthy', 'recovering', 'recovered', 'failed']);
  });

  it('never puts a reason, an exit code or a path in what the renderer is told', () => {
    const { recovery } = harness();

    recovery.onRendererGone({ reason: 'oom', exitCode: 9 });

    const notice: string = recovery.notice();

    expect(notice).toBe('after-crash');
    expect(notice).not.toContain('oom');
    expect(notice).not.toContain('9');
    expect(notice).not.toContain('/');
  });
});
