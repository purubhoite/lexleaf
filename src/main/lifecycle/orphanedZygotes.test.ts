import { describe, expect, it, vi } from 'vitest';

import { parseProcessStat, stopOrphanedZygotes, type ProcessTable } from './orphanedZygotes';

interface FakeProcess {
  readonly name: string;
  readonly parent: number;
  readonly args: readonly string[];
}

const ZYGOTE = ['/opt/Lexleaf/lexleaf', '--type=zygote', '--no-zygote-sandbox'];

const tableOf = (processes: Readonly<Record<number, FakeProcess>>): ProcessTable => ({
  list: () => [...Object.keys(processes), 'self', 'meminfo', 'sys'],
  read: (pid, file) => {
    const found = processes[pid];

    if (found === undefined) {
      return null;
    }

    return file === 'stat'
      ? `${String(pid)} (${found.name}) R ${String(found.parent)} 1 1 0 -1 4194560`
      : `${found.args.join('\0')}\0`;
  },
});

const sweep = (processes: Readonly<Record<number, FakeProcess>>, kill = vi.fn()) => {
  const onDiagnostic = vi.fn();
  const stopped = stopOrphanedZygotes({
    table: tableOf(processes),
    ownName: 'lexleaf',
    ownPid: 100,
    kill,
    onDiagnostic,
  });

  return { stopped, kill, onDiagnostic };
};

const SESSION: Readonly<Record<number, FakeProcess>> = {
  1: { name: 'systemd', parent: 0, args: ['/sbin/init'] },
  50: { name: 'gnome-shell', parent: 1, args: ['/usr/bin/gnome-shell'] },
  100: { name: 'lexleaf', parent: 50, args: ['/opt/Lexleaf/lexleaf'] },
  101: { name: 'lexleaf', parent: 100, args: ZYGOTE },
  102: { name: 'lexleaf', parent: 101, args: ['/opt/Lexleaf/lexleaf', '--type=zygote'] },
  103: { name: 'lexleaf', parent: 102, args: ['/opt/Lexleaf/lexleaf', '--type=renderer'] },
  104: { name: 'lexleaf', parent: 100, args: ['/opt/Lexleaf/lexleaf', '--type=gpu-process'] },
};

describe('reading a process entry', () => {
  it('takes the name and the parent', () => {
    expect(parseProcessStat('101 (lexleaf) S 100 1 1')).toStrictEqual({
      name: 'lexleaf',
      parent: 100,
    });
  });

  it('copes with spaces and parentheses in the name', () => {
    expect(parseProcessStat('7 (Web (Content) x) R 3 1 1')).toStrictEqual({
      name: 'Web (Content) x',
      parent: 3,
    });
  });

  it('refuses what it cannot read', () => {
    for (const stat of [null, '', '101 lexleaf S 100', '101 (lexleaf) S', '101 (lexleaf) S x']) {
      expect(parseProcessStat(stat)).toBeNull();
    }
  });
});

describe('stopping zygotes that have no application behind them', () => {
  it('leaves a healthy running application alone', () => {
    const { stopped, kill } = sweep(SESSION);

    expect(stopped).toStrictEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it('stops a zygote that was relaunched on its own', () => {
    const { stopped, kill, onDiagnostic } = sweep({
      ...SESSION,
      // What a crash reporter's "relaunch" leaves behind.
      900: { name: 'lexleaf', parent: 1, args: ['sh', '-c', ZYGOTE.join(' ')] },
    });

    expect(stopped).toStrictEqual([900]);
    expect(kill).toHaveBeenCalledExactlyOnceWith(900);
    expect(onDiagnostic).toHaveBeenCalledOnce();
  });

  it('stops one whose parent has gone', () => {
    const { stopped } = sweep({
      100: { name: 'lexleaf', parent: 50, args: ['/opt/Lexleaf/lexleaf'] },
      900: { name: 'lexleaf', parent: 4242, args: ZYGOTE },
    });

    expect(stopped).toStrictEqual([900]);
  });

  it("leaves another running copy's zygotes alone", () => {
    const { stopped } = sweep({
      ...SESSION,
      200: { name: 'lexleaf', parent: 50, args: ['/opt/Lexleaf/lexleaf'] },
      201: { name: 'lexleaf', parent: 200, args: ZYGOTE },
    });

    expect(stopped).toStrictEqual([]);
  });

  it('never touches another program, whatever its command line says', () => {
    const { stopped } = sweep({
      ...SESSION,
      300: { name: 'slack', parent: 1, args: ['/usr/lib/slack/slack', '--type=zygote'] },
      301: { name: 'chrome', parent: 1, args: ['/opt/google/chrome/chrome', '--type=zygote'] },
    });

    expect(stopped).toStrictEqual([]);
  });

  it('never touches a Lexleaf process that is not a zygote', () => {
    const { stopped } = sweep({
      1: { name: 'systemd', parent: 0, args: ['/sbin/init'] },
      100: { name: 'lexleaf', parent: 1, args: ['/opt/Lexleaf/lexleaf'] },
      400: { name: 'lexleaf', parent: 1, args: ['/opt/Lexleaf/lexleaf', 'book.pdf'] },
      401: { name: 'lexleaf', parent: 1, args: ['/opt/Lexleaf/lexleaf', '--type=zygote-ish'] },
    });

    expect(stopped).toStrictEqual([]);
  });

  it('never stops itself', () => {
    const { stopped } = sweep({
      100: { name: 'lexleaf', parent: 1, args: ZYGOTE },
    });

    expect(stopped).toStrictEqual([]);
  });

  it('carries on when a process cannot be stopped', () => {
    const kill = vi.fn((pid: number) => {
      if (pid === 900) {
        throw new Error('EPERM');
      }
    });
    const { stopped } = sweep(
      {
        ...SESSION,
        900: { name: 'lexleaf', parent: 1, args: ZYGOTE },
        901: { name: 'lexleaf', parent: 1, args: ZYGOTE },
      },
      kill,
    );

    expect(stopped).toStrictEqual([901]);
  });

  it('does nothing when the process table cannot be read or the name is unknown', () => {
    const kill = vi.fn();
    const broken: ProcessTable = {
      list: () => {
        throw new Error('ENOENT');
      },
      read: () => null,
    };

    expect(
      stopOrphanedZygotes({
        table: broken,
        ownName: 'lexleaf',
        ownPid: 100,
        kill,
        onDiagnostic: vi.fn(),
      }),
    ).toStrictEqual([]);
    expect(
      stopOrphanedZygotes({
        table: tableOf({ 900: { name: '', parent: 1, args: ZYGOTE } }),
        ownName: '',
        ownPid: 100,
        kill,
        onDiagnostic: vi.fn(),
      }),
    ).toStrictEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });
});
