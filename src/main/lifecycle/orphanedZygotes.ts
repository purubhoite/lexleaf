/**
 * Stops helper processes of Lexleaf that have no Lexleaf behind them.
 *
 * Linux only. Chromium starts its renderers from a "zygote" process, which
 * takes its instructions from the application over a socket. A zygote that
 * is started — or left — without that socket does not exit: it retries the
 * read in a tight loop, at a full processor core, and writes
 *
 *   Error reading message from browser: Socket operation on non-socket (88)
 *
 * to its error output thousands of times a second. On a desktop session
 * that output is the system log, which grows until the disk is full. This
 * is a Chromium defect (electron/electron#49967, closed as upstream) that
 * has filled disks for several Electron applications.
 *
 * The known way to get there on Ubuntu: a helper process crashes, the
 * system's crash reporter offers to relaunch "the application", and what
 * it relaunches is the helper's own command line — a zygote on its own.
 * The Debian package tells the crash reporter to leave Lexleaf alone;
 * this is the second line of defence, for the AppImage and for any other
 * way of arriving in the same state.
 *
 * The rule is narrow on purpose. A process is stopped only if all of:
 *
 * - it is a Lexleaf process (same executable name as this one),
 * - it is a zygote (`--type=zygote` on its command line),
 * - its parent is *not* a Lexleaf process.
 *
 * Every healthy zygote is the child of the application or of another
 * zygote, so nothing a running Lexleaf depends on can match. Only the
 * process table is read, and only this user's processes can be signalled.
 */

export interface ProcessTable {
  /** Names in `/proc`. */
  list(): readonly string[];
  /** Contents of `/proc/<pid>/<file>`, or `null` if it cannot be read. */
  read(pid: number, file: 'stat' | 'cmdline'): string | null;
}

export interface OrphanedZygoteOptions {
  readonly table: ProcessTable;
  /** The kernel's name for this process: `/proc/self/stat`'s second field. */
  readonly ownName: string;
  readonly ownPid: number;
  /** Throws if the process cannot be signalled. */
  readonly kill: (pid: number) => void;
  readonly onDiagnostic: (message: string) => void;
}

interface ProcessStat {
  readonly name: string;
  readonly parent: number;
}

/**
 * `pid (name) state ppid …`. The name may itself contain spaces and
 * parentheses, so it is everything between the first `(` and the last `)`.
 */
export const parseProcessStat = (stat: string | null): ProcessStat | null => {
  if (stat === null) {
    return null;
  }

  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');

  if (open === -1 || close < open) {
    return null;
  }

  const parent = Number.parseInt(
    stat
      .slice(close + 1)
      .trim()
      .split(/\s+/u)[1] ?? '',
    10,
  );

  return Number.isInteger(parent) ? { name: stat.slice(open + 1, close), parent } : null;
};

const isZygoteCommandLine = (commandLine: string | null): boolean =>
  commandLine !== null && commandLine.split(/[\0\s]+/u).includes('--type=zygote');

/** Returns the process ids that were stopped. Never throws. */
export const stopOrphanedZygotes = ({
  table,
  ownName,
  ownPid,
  kill,
  onDiagnostic,
}: OrphanedZygoteOptions): readonly number[] => {
  const stopped: number[] = [];

  if (ownName.length === 0) {
    return stopped;
  }

  let entries: readonly string[];

  try {
    entries = table.list();
  } catch {
    return stopped;
  }

  for (const entry of entries) {
    if (!/^[0-9]+$/u.test(entry)) {
      continue;
    }

    const pid = Number.parseInt(entry, 10);

    if (pid === ownPid) {
      continue;
    }

    const stat = parseProcessStat(table.read(pid, 'stat'));

    if (
      stat === null ||
      stat.name !== ownName ||
      !isZygoteCommandLine(table.read(pid, 'cmdline'))
    ) {
      continue;
    }

    const parent = parseProcessStat(table.read(stat.parent, 'stat'));

    if (parent !== null && parent.name === ownName) {
      // A zygote with a Lexleaf above it: ours, or another copy's.
      continue;
    }

    try {
      kill(pid);
      stopped.push(pid);
      onDiagnostic(
        `stopped a helper process that had no application behind it (pid ${String(pid)})`,
      );
    } catch {
      // Gone already, or not ours to stop. Either way there is nothing to do.
    }
  }

  return stopped;
};

/** How often a running Lexleaf looks. The loop fills gigabytes an hour. */
export const ORPHANED_ZYGOTE_SWEEP_INTERVAL_MS = 2 * 60 * 1000;
