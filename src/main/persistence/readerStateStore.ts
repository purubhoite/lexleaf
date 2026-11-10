import { emptyReaderState } from '@core/persistence/readerState';
import { parseReaderState, serializeReaderState } from '@core/persistence/schema';
import type { ReaderState } from '@core/persistence/types';
import type { StateWriteHealth } from '@shared/ipc/contracts';

/**
 * The only code in the application that stores reading state on a disk.
 *
 * Three properties matter here, and each is a rule rather than a hope
 * (ADR-016):
 *
 * - **atomicity** — the document is written to a temporary file and renamed
 *   over the real one, so an interrupted write cannot leave a half-written
 *   file behind;
 * - **recoverability** — a file that will not parse is moved aside and the
 *   application starts with empty state instead of refusing to run;
 * - **harmlessness** — every failure is reported once and swallowed. Nothing
 *   here may prevent a document from being opened. Harmless is not the same
 *   as invisible, though, which is what M7 investigation R6 recorded: since
 *   M7.2 the store also *remembers* whether its last write reached the disk,
 *   so the channels that caused the write can answer honestly (ADR-034).
 *   The log keeps its once-per-kind rule; the flag is not a second log.
 *
 * The filesystem is injected so all three are unit tested without touching a
 * real disk.
 */

export interface StateFiles {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /**
   * Flush the named file's contents to the storage device (M7.3, R7).
   *
   * Optional on purpose. `rename` is atomic on POSIX and NTFS whether or
   * not the data behind it has reached the platter, so a runtime that
   * cannot offer this still gets crash-atomicity — it just does not get
   * the stronger power-loss ordering. A store built without it behaves
   * exactly as it did before M7.3 rather than refusing to save.
   */
  syncFile?(path: string): Promise<void>;
  /**
   * Flush the *directory entry* created by the rename (M7.3, R7).
   *
   * Optional and best effort: opening a directory for sync is not
   * portable, and several filesystems reject it outright. A failure here
   * is recorded once and otherwise ignored, because the rename itself has
   * already happened and refusing it afterwards would help nobody.
   */
  syncDirectory?(path: string): Promise<void>;
  /** Remove the temporary file after a failed rename (M7.3, R8). */
  remove?(path: string): Promise<void>;
}

export interface ReaderStateStoreOptions {
  readonly filePath: string;
  readonly files: StateFiles;
  /** Reported to the log once per kind of failure; never shown to the reader. */
  readonly onWarning: (message: string) => void;
  /**
   * Scrolling produces a position update several times a second, so writes
   * are coalesced. The store still flushes on demand (application quit).
   */
  readonly writeDelayMs?: number;
}

export interface ReaderStateStore {
  /** Reads the file once; later calls return the in-memory copy. */
  load(): Promise<ReaderState>;
  /**
   * Whether the most recent write attempt reached the disk (M7.2).
   *
   * `ok` before anything has been written: nothing has failed. It
   * describes the last attempt rather than the session, so a store that
   * recovers says so.
   */
  writeHealth(): StateWriteHealth;
  /** The current state without touching the disk. */
  current(): ReaderState;
  /** Applies a pure change and schedules a write. */
  update(change: (state: ReaderState) => ReaderState): void;
  /** Writes immediately if anything is pending. */
  flush(): Promise<void>;
}

const DEFAULT_WRITE_DELAY_MS = 1_000;

const isMissingFile = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createReaderStateStore = ({
  filePath,
  files,
  onWarning,
  writeDelayMs = DEFAULT_WRITE_DELAY_MS,
}: ReaderStateStoreOptions): ReaderStateStore => {
  const temporaryPath = `${filePath}.tmp`;
  const directoryPath = filePath.replace(/[\\/][^\\/]*$/u, '') || '.';
  const quarantinePath = filePath.replace(/\.json$/u, '') + '.corrupt.json';

  let state = emptyReaderState();
  let loaded = false;
  let dirty = false;
  /** Bumped by every update so a write can tell whether it is still current. */
  let revision = 0;
  let health: StateWriteHealth = 'ok';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  const warned = new Set<string>();

  const warnOnce = (kind: string, message: string): void => {
    if (!warned.has(kind)) {
      warned.add(kind);
      onWarning(message);
    }
  };

  const quarantine = async (reason: string): Promise<void> => {
    try {
      await files.rename(filePath, quarantinePath);
      onWarning(`reading state was ${reason}; moved to ${quarantinePath} and started fresh`);
    } catch (error) {
      warnOnce(
        'quarantine',
        `reading state was ${reason} and could not be moved aside: ${describe(error)}`,
      );
    }
  };

  /**
   * Best-effort durability steps. Neither may turn a write that otherwise
   * succeeded into a failure: the contract is "the bytes are in place",
   * and a runtime without `fsync` still satisfies it.
   */
  const syncFileIfSupported = async (path: string): Promise<void> => {
    if (files.syncFile === undefined) {
      return;
    }

    try {
      await files.syncFile(path);
    } catch (error) {
      warnOnce('fsync', `reading state could not be flushed to the disk: ${describe(error)}`);
    }
  };

  const syncDirectoryIfSupported = async (): Promise<void> => {
    if (files.syncDirectory === undefined) {
      return;
    }

    try {
      await files.syncDirectory(directoryPath);
    } catch (error) {
      warnOnce(
        'fsyncdir',
        `the reading-state directory could not be flushed to the disk: ${describe(error)}`,
      );
    }
  };

  /**
   * R8. A rename that failed leaves the temporary file behind, and the
   * next write would leave another. The removal is itself allowed to
   * fail — on a read-only filesystem it certainly will — and when it does
   * that is a second diagnostic, never a reason to lose the state the
   * reader is still holding in memory.
   */
  const discardTemporaryFile = async (): Promise<void> => {
    if (files.remove === undefined) {
      return;
    }

    try {
      await files.remove(temporaryPath);
    } catch (error) {
      warnOnce(
        'cleanup',
        `the temporary reading-state file could not be removed: ${describe(error)}`,
      );
    }
  };

  const write = async (): Promise<void> => {
    if (!dirty) {
      return;
    }

    /*
     * The revision is captured *before* the write and compared after it
     * (M7.3, the remaining half of R6). Clearing `dirty` up front, as this
     * did until M7.3, threw the pending delta away the moment a write
     * failed: the position the reader had just scrolled to was gone and
     * nothing would ever try again. Now the flag survives the attempt, and
     * it is only lowered when the write that succeeded carried the state
     * the application currently holds. An update that landed mid-write
     * leaves it raised, so the next eligible write carries that one too.
     */
    const attempted = revision;
    const contents = serializeReaderState(state);

    try {
      await files.writeFile(temporaryPath, contents);
      await syncFileIfSupported(temporaryPath);
      await files.rename(temporaryPath, filePath);
      await syncDirectoryIfSupported();

      health = 'ok';

      if (revision === attempted) {
        dirty = false;
      }
    } catch (error) {
      /*
       * Two different things happen here, and they are deliberately not
       * the same thing. The log line is written once per kind of failure,
       * because a position is written several times a minute and a
       * read-only profile directory would otherwise fill the log with one
       * identical line. The health flag is set every time, because it is
       * not a report — it is the answer to "did that write happen?", and
       * the renderer asks it again after every save (M7.2, R6).
       *
       * `dirty` is deliberately left raised. There is no self-driving
       * retry timer: the next update or the quit flush carries the state,
       * which is a retry without a loop that can run away on its own.
       */
      health = 'failing';
      warnOnce('write', `reading state could not be saved: ${describe(error)}`);
      await discardTemporaryFile();
    }
  };

  const schedule = (): void => {
    if (timer !== null) {
      return;
    }

    timer = setTimeout(() => {
      timer = null;
      writing = writing.then(write);
    }, writeDelayMs);

    // The timer must not keep an otherwise idle application alive.
    timer.unref?.();
  };

  return {
    async load(): Promise<ReaderState> {
      if (loaded) {
        return state;
      }

      loaded = true;

      let contents: string;

      try {
        contents = await files.readFile(filePath);
      } catch (error) {
        if (!isMissingFile(error)) {
          warnOnce('read', `reading state could not be read: ${describe(error)}`);
        }
        return state;
      }

      const parsed = parseReaderState(contents);

      if (parsed.recoveredFrom !== null) {
        await quarantine(parsed.recoveredFrom);
        return state;
      }

      if (parsed.droppedRecords > 0) {
        onWarning(
          `ignored ${String(parsed.droppedRecords)} malformed entries in the reading state`,
        );
      }

      state = parsed.state;

      return state;
    },

    current: (): ReaderState => state,

    writeHealth: (): StateWriteHealth => health,

    update(change: (previous: ReaderState) => ReaderState): void {
      state = change(state);
      dirty = true;
      revision += 1;
      schedule();
    },

    async flush(): Promise<void> {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }

      writing = writing.then(write);
      await writing;
    },
  };
};
