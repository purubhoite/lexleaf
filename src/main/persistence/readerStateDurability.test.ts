import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyReaderState, rememberOpen } from '@core/persistence/readerState';
import { parseReaderState, serializeReaderState } from '@core/persistence/schema';
import type { ReaderState } from '@core/persistence/types';

import { createReaderStateStore, type StateFiles } from './readerStateStore';

/**
 * M7.3 — the durability half of the store: R7 (rename is not durable),
 * R8 (a failed rename leaves a stale `.tmp`) and the remaining half of
 * R6 (a failed write threw the pending delta away).
 *
 * The existing store suite covers atomicity and recovery and is left
 * exactly as it is; this file adds the ordering, cleanup and retry
 * properties, which are about *when* things happen rather than what the
 * file ends up containing.
 */

const STATE_PATH = '/config/reader-state.json';
const TEMP_PATH = `${STATE_PATH}.tmp`;
const DIRECTORY = '/config';

interface Disk extends StateFiles {
  readonly contents: Map<string, string>;
  /** Every filesystem call, in order. This is what proves the ordering. */
  readonly calls: string[];
  failWrites: boolean;
  failRenames: boolean;
  failFileSync: boolean;
  failDirectorySync: boolean;
  failRemove: boolean;
}

const createDisk = (initial?: string): Disk => {
  const contents = new Map<string, string>();

  if (initial !== undefined) {
    contents.set(STATE_PATH, initial);
  }

  const disk: Disk = {
    contents,
    calls: [],
    failWrites: false,
    failRenames: false,
    failFileSync: false,
    failDirectorySync: false,
    failRemove: false,

    readFile: (path) => {
      const found = contents.get(path);

      return found === undefined
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : Promise.resolve(found);
    },

    writeFile: (path, text) => {
      disk.calls.push(`write:${path}`);

      if (disk.failWrites) {
        return Promise.reject(new Error('disk full'));
      }

      contents.set(path, text);

      return Promise.resolve();
    },

    syncFile: (path) => {
      disk.calls.push(`fsync:${path}`);

      return disk.failFileSync
        ? Promise.reject(Object.assign(new Error('EINVAL'), { code: 'EINVAL' }))
        : Promise.resolve();
    },

    rename: (from, to) => {
      disk.calls.push(`rename:${from}->${to}`);

      if (disk.failRenames) {
        return Promise.reject(new Error('read-only filesystem'));
      }

      const value = contents.get(from);

      if (value === undefined) {
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }

      contents.delete(from);
      contents.set(to, value);

      return Promise.resolve();
    },

    syncDirectory: (path) => {
      disk.calls.push(`fsyncdir:${path}`);

      return disk.failDirectorySync
        ? Promise.reject(Object.assign(new Error('EISDIR'), { code: 'EISDIR' }))
        : Promise.resolve();
    },

    remove: (path) => {
      disk.calls.push(`remove:${path}`);

      if (disk.failRemove) {
        return Promise.reject(new Error('permission denied'));
      }

      contents.delete(path);

      return Promise.resolve();
    },
  };

  return disk;
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

const build = (
  disk: Disk,
  onWarning: (message: string) => void = vi.fn(),
): ReturnType<typeof createReaderStateStore> =>
  createReaderStateStore({ filePath: STATE_PATH, files: disk, onWarning, writeDelayMs: 1_000 });

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(1_000);
};

const recentNames = (text: string): string[] =>
  parseReaderState(text).state.documents.map((entry) => entry.name);

describe('M7.3 — durable writes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes the temporary file to the disk before renaming it into place', async () => {
    const disk = createDisk();
    const store = build(disk);

    store.update((state) => openDocument(state, 'a'));
    await settle();

    expect(disk.calls).toEqual([
      `write:${TEMP_PATH}`,
      `fsync:${TEMP_PATH}`,
      `rename:${TEMP_PATH}->${STATE_PATH}`,
      `fsyncdir:${DIRECTORY}`,
    ]);
  });

  it('still writes when the runtime offers no sync at all', async () => {
    const disk = createDisk();
    // A runtime that offers neither sync: the two optional members are
    // simply absent, which is what an unsupported platform looks like.
    const withoutSync: StateFiles = {
      readFile: (path) => disk.readFile(path),
      writeFile: (path, contents) => disk.writeFile(path, contents),
      rename: (from, to) => disk.rename(from, to),
      remove: (path) => disk.remove?.(path) ?? Promise.resolve(),
    };

    const store = createReaderStateStore({
      filePath: STATE_PATH,
      files: withoutSync,
      onWarning: vi.fn(),
      writeDelayMs: 1_000,
    });

    store.update((state) => openDocument(state, 'a'));
    await settle();

    expect(disk.contents.has(STATE_PATH)).toBe(true);
    expect(store.writeHealth()).toBe('ok');
    expect(disk.calls).toEqual([`write:${TEMP_PATH}`, `rename:${TEMP_PATH}->${STATE_PATH}`]);
  });

  it('treats a failing file sync as a diagnostic, not a failed write', async () => {
    const disk = createDisk();
    const warnings: string[] = [];
    const store = build(disk, (message) => warnings.push(message));

    disk.failFileSync = true;

    store.update((state) => openDocument(state, 'a'));
    await settle();

    expect(disk.contents.has(STATE_PATH)).toBe(true);
    expect(store.writeHealth()).toBe('ok');
    expect(warnings.join()).toContain('could not be flushed to the disk');
  });

  it('treats a failing directory sync as a diagnostic, not a failed write', async () => {
    const disk = createDisk();
    const warnings: string[] = [];
    const store = build(disk, (message) => warnings.push(message));

    disk.failDirectorySync = true;

    store.update((state) => openDocument(state, 'a'));
    await settle();

    expect(disk.contents.has(STATE_PATH)).toBe(true);
    expect(store.writeHealth()).toBe('ok');
    expect(warnings.join()).toContain('directory could not be flushed');
  });

  it('warns once per kind however many syncs fail', async () => {
    const disk = createDisk();
    const warnings: string[] = [];
    const store = build(disk, (message) => warnings.push(message));

    disk.failFileSync = true;
    disk.failDirectorySync = true;

    for (let i = 0; i < 5; i += 1) {
      store.update((state) => openDocument(state, `doc-${String(i)}`));
      await settle();
    }

    expect(
      warnings.filter((line) => line.startsWith('reading state could not be flushed')),
    ).toHaveLength(1);
    expect(warnings.filter((line) => line.includes('directory could not be flushed'))).toHaveLength(
      1,
    );
  });
});

describe('M7.3 — a rename that fails (R8)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves the last known-good state file untouched', async () => {
    const good = serializeReaderState(openDocument(emptyReaderState(), 'good'));
    const disk = createDisk(good);
    const store = build(disk);

    disk.failRenames = true;

    store.update((state) => openDocument(state, 'new'));
    await settle();

    expect(disk.contents.get(STATE_PATH)).toBe(good);
    expect(store.writeHealth()).toBe('failing');
  });

  it('removes the temporary file it could not rename', async () => {
    const disk = createDisk();
    const store = build(disk);

    disk.failRenames = true;

    store.update((state) => openDocument(state, 'a'));
    await settle();

    expect(disk.calls).toContain(`remove:${TEMP_PATH}`);
    expect(disk.contents.has(TEMP_PATH)).toBe(false);
  });

  it('never accumulates temporary files across repeated failures', async () => {
    const disk = createDisk();
    const store = build(disk);

    disk.failRenames = true;

    for (let i = 0; i < 6; i += 1) {
      store.update((state) => openDocument(state, `doc-${String(i)}`));
      await settle();
    }

    expect([...disk.contents.keys()].filter((path) => path.endsWith('.tmp'))).toEqual([]);
  });

  it('reports a cleanup that itself fails, and still keeps the primary state', async () => {
    const good = serializeReaderState(openDocument(emptyReaderState(), 'good'));
    const disk = createDisk(good);
    const warnings: string[] = [];
    const store = build(disk, (message) => warnings.push(message));

    disk.failRenames = true;
    disk.failRemove = true;

    store.update((state) => openDocument(state, 'new'));
    await settle();

    expect(warnings.join()).toContain('temporary reading-state file could not be removed');
    expect(disk.contents.get(STATE_PATH)).toBe(good);
    expect(store.current().documents.map((entry) => entry.name)).toContain('new.pdf');
  });

  it('cleans up after a failed write too', async () => {
    const disk = createDisk();
    const store = build(disk);

    disk.failWrites = true;

    store.update((state) => openDocument(state, 'a'));
    await settle();

    expect(disk.calls).toContain(`remove:${TEMP_PATH}`);
  });
});

describe('M7.3 — a failed write keeps its delta (R6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retains the pending state and writes it once the disk recovers', async () => {
    const disk = createDisk();
    const store = build(disk);

    disk.failRenames = true;

    store.update((state) => openDocument(state, 'pending'));
    await settle();

    expect(disk.contents.has(STATE_PATH)).toBe(false);
    expect(store.writeHealth()).toBe('failing');

    // The disk recovers; the next eligible write carries the delta that
    // the failed one was holding.
    disk.failRenames = false;

    store.update((state) => openDocument(state, 'later'));
    await settle();

    expect(store.writeHealth()).toBe('ok');
    expect(recentNames(disk.contents.get(STATE_PATH) ?? '')).toEqual(
      expect.arrayContaining(['pending.pdf', 'later.pdf']),
    );
  });

  it('retries the pending delta on a flush, with no update in between', async () => {
    const disk = createDisk();
    const store = build(disk);

    disk.failRenames = true;

    store.update((state) => openDocument(state, 'pending'));
    await settle();

    disk.failRenames = false;
    await store.flush();

    expect(recentNames(disk.contents.get(STATE_PATH) ?? '')).toEqual(['pending.pdf']);
    expect(store.writeHealth()).toBe('ok');
  });

  it('clears the pending flag once a write succeeds, so a later flush is a no-op', async () => {
    const disk = createDisk();
    const store = build(disk);

    store.update((state) => openDocument(state, 'a'));
    await settle();

    const after = disk.calls.length;

    await store.flush();
    await store.flush();

    expect(disk.calls).toHaveLength(after);
  });

  it('keeps an update that arrives during a write pending for the next one', async () => {
    const disk = createDisk();
    let releaseRename = (): void => undefined;

    let blockNextRename = true;

    const slow: Disk = {
      ...disk,
      rename: async (from, to) => {
        disk.calls.push(`rename:${from}->${to}`);

        if (blockNextRename) {
          blockNextRename = false;
          await new Promise<void>((resolve) => {
            releaseRename = resolve;
          });
        }

        const value = disk.contents.get(from);

        disk.contents.delete(from);
        disk.contents.set(to, value ?? '');
      },
    };

    const store = createReaderStateStore({
      filePath: STATE_PATH,
      files: slow,
      onWarning: vi.fn(),
      writeDelayMs: 1_000,
    });

    store.update((state) => openDocument(state, 'first'));
    await vi.advanceTimersByTimeAsync(1_000);

    // The rename is in flight; a second change lands now.
    store.update((state) => openDocument(state, 'second'));
    releaseRename();
    await vi.advanceTimersByTimeAsync(1_000);
    await store.flush();

    expect(recentNames(disk.contents.get(STATE_PATH) ?? '')).toEqual(
      expect.arrayContaining(['first.pdf', 'second.pdf']),
    );
  });

  it('reports the failure once however many writes fail, and recovers the flag', async () => {
    const disk = createDisk();
    const warnings: string[] = [];
    const store = build(disk, (message) => warnings.push(message));

    disk.failRenames = true;

    for (let i = 0; i < 5; i += 1) {
      store.update((state) => openDocument(state, `doc-${String(i)}`));
      await settle();
    }

    expect(warnings.filter((line) => line.includes('could not be saved'))).toHaveLength(1);
    expect(store.writeHealth()).toBe('failing');

    disk.failRenames = false;
    await store.flush();

    expect(store.writeHealth()).toBe('ok');
  });
});
