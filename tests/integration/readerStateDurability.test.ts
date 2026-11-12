import {
  chmod,
  mkdtemp,
  open as openFile,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { emptyReaderState, rememberOpen } from '@core/persistence/readerState';
import { parseReaderState, serializeReaderState } from '@core/persistence/schema';
import type { ReaderState } from '@core/persistence/types';

import { createReaderStateStore } from '../../src/main/persistence/readerStateStore';
import {
  claimSingleInstance,
  type SingleInstanceApp,
} from '../../src/main/lifecycle/singleInstance';
import { createQuitFlush } from '../../src/main/lifecycle/quitFlush';

/**
 * M7.3 against a real filesystem.
 *
 * The unit suite proves the ordering with an injected disk. This proves
 * the same properties with the adapter the application actually installs,
 * on real files, including a rename that genuinely fails because the
 * directory is genuinely read-only.
 */

let workspace = '';

const realFiles = {
  readFile: async (path: string): Promise<string> => readFile(path, 'utf8'),
  writeFile: async (path: string, contents: string): Promise<void> =>
    writeFile(path, contents, 'utf8'),
  rename: async (from: string, to: string): Promise<void> => rename(from, to),
  syncFile: async (path: string): Promise<void> => {
    const handle = await openFile(path, 'r+');

    try {
      await handle.datasync();
    } finally {
      await handle.close();
    }
  },
  syncDirectory: async (path: string): Promise<void> => {
    const handle = await openFile(path, 'r');

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  remove: async (path: string): Promise<void> => unlink(path),
};

const openDocument = (state: ReaderState, name: string): ReaderState =>
  rememberOpen(state, {
    id: `id-${name}`,
    path: `/books/${name}.pdf`,
    name: `${name}.pdf`,
    sizeBytes: 10,
    pageCount: 3,
    at: '2026-01-01T00:00:00.000Z',
  });

const names = (text: string): string[] =>
  parseReaderState(text).state.documents.map((entry) => entry.name);

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'reader-durability-'));
});

afterAll(async () => {
  // Every directory this suite made must be traversable again before it
  // can be removed; one test deliberately makes one read-only.
  await chmod(workspace, 0o755).catch(() => undefined);

  for (const entry of await readdir(workspace).catch(() => [])) {
    await chmod(join(workspace, entry), 0o755).catch(() => undefined);
  }

  await rm(workspace, { recursive: true, force: true });
});

describe('the reader state store on a real filesystem', () => {
  it('writes through a temporary file and leaves none behind', async () => {
    const directory = await mkdtemp(join(workspace, 'ok-'));
    const filePath = join(directory, 'reader-state.json');

    const store = createReaderStateStore({
      filePath,
      files: realFiles,
      onWarning: () => undefined,
      writeDelayMs: 5,
    });

    store.update((state) => openDocument(state, 'alpha'));
    await store.flush();

    expect(names(await readFile(filePath, 'utf8'))).toEqual(['alpha.pdf']);
    expect(await readdir(directory)).toEqual(['reader-state.json']);
  });

  it('keeps the last good file and removes the temporary one when the rename fails', async () => {
    const directory = await mkdtemp(join(workspace, 'ro-'));
    const filePath = join(directory, 'reader-state.json');
    const good = serializeReaderState(openDocument(emptyReaderState(), 'good'));

    await writeFile(filePath, good, 'utf8');

    const warnings: string[] = [];
    const store = createReaderStateStore({
      filePath,
      files: {
        ...realFiles,
        // The one thing a read-only directory cannot do. Everything else
        // is the real adapter.
        rename: () =>
          Promise.reject(
            Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }),
          ),
      },
      onWarning: (message) => warnings.push(message),
      writeDelayMs: 5,
    });

    store.update((state) => openDocument(state, 'doomed'));
    await store.flush();

    expect(await readFile(filePath, 'utf8')).toBe(good);
    expect(await readdir(directory)).toEqual(['reader-state.json']);
    expect(store.writeHealth()).toBe('failing');
    expect(warnings.join()).toContain('could not be saved');
  });

  it('retries the pending delta against the real disk once renaming works again', async () => {
    const directory = await mkdtemp(join(workspace, 'retry-'));
    const filePath = join(directory, 'reader-state.json');

    let broken = true;
    const store = createReaderStateStore({
      filePath,
      files: {
        ...realFiles,
        rename: async (from: string, to: string): Promise<void> => {
          if (broken) {
            throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
          }

          await rename(from, to);
        },
      },
      onWarning: () => undefined,
      writeDelayMs: 5,
    });

    store.update((state) => openDocument(state, 'pending'));
    await store.flush();

    expect(store.writeHealth()).toBe('failing');

    broken = false;
    await store.flush();

    expect(store.writeHealth()).toBe('ok');
    expect(names(await readFile(filePath, 'utf8'))).toEqual(['pending.pdf']);
    expect(await readdir(directory)).toEqual(['reader-state.json']);
  });

  it('preserves in-memory state when the state parent is blocked by a file', async () => {
    const directory = await mkdtemp(join(workspace, 'blocked-'));
    const blocker = join(directory, 'state-parent');
    const filePath = join(blocker, 'reader-state.json');

    // A regular file where the parent directory must be is a deterministic
    // failure on both POSIX and Windows, unlike chmod-based read-only tests.
    await writeFile(blocker, 'not a directory', 'utf8');

    const store = createReaderStateStore({
      filePath,
      files: realFiles,
      onWarning: () => undefined,
      writeDelayMs: 5,
    });

    store.update((state) => openDocument(state, 'unwritable'));
    await store.flush();

    expect(store.writeHealth()).toBe('failing');
    expect(store.current().documents.map((entry) => entry.name)).toContain('unwritable.pdf');
  });

  it('flushes the real state on quit, awaiting the write', async () => {
    const directory = await mkdtemp(join(workspace, 'quit-'));
    const filePath = join(directory, 'reader-state.json');

    const store = createReaderStateStore({
      filePath,
      files: realFiles,
      onWarning: () => undefined,
      // Long enough that only the quit flush can make this land.
      writeDelayMs: 60_000,
    });

    store.update((state) => openDocument(state, 'last-page'));

    let quit = 0;
    const quitFlush = createQuitFlush({
      flush: async () => {
        await store.flush();

        return store.writeHealth() === 'ok' ? 'saved' : 'not-saved';
      },
      quit: () => {
        quit += 1;
      },
      onDiagnostic: () => undefined,
    });

    await expect(readFile(filePath, 'utf8')).rejects.toThrow();

    quitFlush.onBeforeQuit({ preventDefault: () => undefined });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(quit).toBe(1);
    expect(quitFlush.phase()).toBe('done');
    expect(names(await readFile(filePath, 'utf8'))).toEqual(['last-page.pdf']);
  });
});

describe('two launches against one user-data directory', () => {
  /**
   * The R4 scenario without two real processes: one lock, two claims.
   * The second gets `false` from Electron's lock exactly as a second
   * process would, and the assertion is that it never becomes a writer.
   */
  const createLock = (): { makeApp: () => SingleInstanceApp & { fire(argv: string[]): void } } => {
    let taken = false;
    const handlers: ((event: unknown, argv: string[], workingDirectory: string) => void)[] = [];

    return {
      makeApp: (): SingleInstanceApp & { fire(argv: string[]): void } => {
        const app = {
          requestSingleInstanceLock: (): boolean => {
            if (taken) {
              return false;
            }

            taken = true;

            return true;
          },
          on: (
            _event: 'second-instance',
            handler: (event: unknown, argv: string[], workingDirectory: string) => void,
          ): void => {
            handlers.push(handler);
          },
          quit: (): void => undefined,
          fire: (argv: string[]): void => {
            for (const handler of handlers) {
              handler({}, argv, '/home/reader');
            }
          },
        };

        return app;
      },
    };
  };

  it('keeps one writer, and both documents end up in one state file', async () => {
    const directory = await mkdtemp(join(workspace, 'two-'));
    const filePath = join(directory, 'reader-state.json');

    const store = createReaderStateStore({
      filePath,
      files: realFiles,
      onWarning: () => undefined,
      writeDelayMs: 5,
    });

    const { makeApp } = createLock();

    // Instance A: wins the lock, opens the first document, writes.
    const appA = makeApp();
    const forwarded: string[] = [];

    const claimA = claimSingleInstance({
      app: appA,
      onForwardedDocument: (path) => forwarded.push(path),
      onFocusRequested: () => undefined,
      onDiagnostic: () => undefined,
    });

    expect(claimA.isOwner).toBe(true);

    store.update((state) => openDocument(state, 'first'));
    await store.flush();

    // Instance B: loses the lock, never writes, hands its argument over.
    const appB = makeApp();
    const claimB = claimSingleInstance({
      app: appB,
      onForwardedDocument: () => {
        throw new Error('a non-owner must never be asked to open anything');
      },
      onFocusRequested: () => undefined,
      onDiagnostic: () => undefined,
    });

    expect(claimB.isOwner).toBe(false);

    appA.fire(['electron', '.', '--open-document=/books/second.pdf']);

    expect(forwarded).toEqual(['/books/second.pdf']);

    // The owner — the only writer — records the forwarded document too.
    store.update((state) => openDocument(state, 'second'));
    await store.flush();

    const onDisk = names(await readFile(filePath, 'utf8'));

    expect(onDisk).toEqual(expect.arrayContaining(['first.pdf', 'second.pdf']));
    expect(await readdir(directory)).toEqual(['reader-state.json']);
  });
});
