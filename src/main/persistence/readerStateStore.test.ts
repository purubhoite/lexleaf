import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyReaderState, rememberOpen } from '@core/persistence/readerState';
import { serializeReaderState } from '@core/persistence/schema';
import type { ReaderState } from '@core/persistence/types';

import { createReaderStateStore, type StateFiles } from './readerStateStore';

const STATE_PATH = '/config/reader-state.json';

interface FakeDisk extends StateFiles {
  readonly contents: Map<string, string>;
  readonly renames: { from: string; to: string }[];
  failWrites: boolean;
  failRenames: boolean;
}

const createDisk = (initial?: string): FakeDisk => {
  const contents = new Map<string, string>();

  if (initial !== undefined) {
    contents.set(STATE_PATH, initial);
  }

  const disk: FakeDisk = {
    contents,
    renames: [],
    failWrites: false,
    failRenames: false,

    readFile: (path: string): Promise<string> => {
      const found = contents.get(path);

      if (found === undefined) {
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }

      return Promise.resolve(found);
    },

    writeFile: (path: string, text: string): Promise<void> => {
      if (disk.failWrites) {
        return Promise.reject(new Error('disk full'));
      }

      contents.set(path, text);

      return Promise.resolve();
    },

    rename: (from: string, to: string): Promise<void> => {
      if (disk.failRenames) {
        return Promise.reject(new Error('read-only filesystem'));
      }

      const value = contents.get(from);

      if (value === undefined) {
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }

      contents.delete(from);
      contents.set(to, value);
      disk.renames.push({ from, to });

      return Promise.resolve();
    },
  };

  return disk;
};

const sample: ReaderState = rememberOpen(emptyReaderState(), {
  id: 'id-a',
  path: '/books/a.pdf',
  name: 'a.pdf',
  sizeBytes: 10,
  pageCount: 3,
  at: '2026-01-01T00:00:00.000Z',
});

const store = (disk: FakeDisk, onWarning = vi.fn()): ReturnType<typeof createReaderStateStore> =>
  createReaderStateStore({ filePath: STATE_PATH, files: disk, onWarning, writeDelayMs: 1_000 });

describe('reader state store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts empty when the file does not exist yet, without warning', async () => {
    const disk = createDisk();
    const onWarning = vi.fn();

    await expect(store(disk, onWarning).load()).resolves.toEqual(emptyReaderState());
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('loads a stored state and then serves it from memory', async () => {
    const disk = createDisk(serializeReaderState(sample));
    const subject = store(disk);

    await expect(subject.load()).resolves.toEqual(sample);

    disk.contents.set(STATE_PATH, 'nonsense');

    // A second load must not re-read; the in-memory copy is authoritative.
    await expect(subject.load()).resolves.toEqual(sample);
    expect(subject.current()).toEqual(sample);
  });

  it('writes atomically: a temporary file first, then a rename over the real one', async () => {
    const disk = createDisk();
    const subject = store(disk);

    await subject.load();
    subject.update(() => sample);
    await subject.flush();

    expect(disk.renames).toEqual([{ from: `${STATE_PATH}.tmp`, to: STATE_PATH }]);
    expect(disk.contents.get(STATE_PATH)).toBe(serializeReaderState(sample));
    expect(disk.contents.has(`${STATE_PATH}.tmp`)).toBe(false);
  });

  it('coalesces a burst of updates into a single write', async () => {
    const disk = createDisk();
    const subject = store(disk);
    const writeFile = vi.spyOn(disk, 'writeFile');

    await subject.load();

    for (let page = 1; page <= 20; page += 1) {
      subject.update((state) => ({ ...state, documents: sample.documents }));
    }

    expect(writeFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when nothing changed', async () => {
    const disk = createDisk();
    const subject = store(disk);
    const writeFile = vi.spyOn(disk, 'writeFile');

    await subject.load();
    await subject.flush();

    expect(writeFile).not.toHaveBeenCalled();
  });

  it('flushes immediately instead of waiting for the timer', async () => {
    const disk = createDisk();
    const subject = store(disk);

    await subject.load();
    subject.update(() => sample);
    await subject.flush();

    expect(disk.contents.get(STATE_PATH)).toBeDefined();

    // The pending timer has been cancelled, so nothing is written twice.
    const writeFile = vi.spyOn(disk, 'writeFile');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('quarantines a corrupt file and starts fresh', async () => {
    const disk = createDisk('{ this is not json');
    const onWarning = vi.fn();
    const subject = store(disk, onWarning);

    await expect(subject.load()).resolves.toEqual(emptyReaderState());
    expect(disk.contents.get('/config/reader-state.corrupt.json')).toBe('{ this is not json');
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('unreadable-json'));
  });

  it('keeps running when the corrupt file cannot even be moved aside', async () => {
    const disk = createDisk('{ this is not json');

    disk.failRenames = true;

    const onWarning = vi.fn();

    await expect(store(disk, onWarning).load()).resolves.toEqual(emptyReaderState());
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('could not be moved aside'));
  });

  it('reports how many malformed entries were ignored', async () => {
    const disk = createDisk(
      JSON.stringify({ schemaVersion: 1, documents: [{ nonsense: true }, { also: 'bad' }] }),
    );
    const onWarning = vi.fn();

    await store(disk, onWarning).load();

    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('ignored 2 malformed entries'));
  });

  it('degrades to memory when the state cannot be written at all', async () => {
    const disk = createDisk();

    disk.failWrites = true;

    const onWarning = vi.fn();
    const subject = store(disk, onWarning);

    await subject.load();
    subject.update(() => sample);
    await subject.flush();

    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('could not be saved'));
    // The in-memory state is still correct, so reading continues normally.
    expect(subject.current()).toEqual(sample);
  });

  /* ---------------------------------------------------------------- *
   * M7.2: the store remembers whether its last write reached the disk
   * ---------------------------------------------------------------- */

  it('starts healthy, because nothing has failed yet', () => {
    expect(store(createDisk()).writeHealth()).toBe('ok');
  });

  it('is healthy after a write that worked', async () => {
    const subject = store(createDisk());

    await subject.load();
    subject.update(() => sample);
    await subject.flush();

    expect(subject.writeHealth()).toBe('ok');
  });

  it('reports failing after a write that did not reach the disk', async () => {
    const disk = createDisk();

    disk.failWrites = true;

    const subject = store(disk, vi.fn());

    await subject.load();
    subject.update(() => sample);
    await subject.flush();

    expect(subject.writeHealth()).toBe('failing');
  });

  it('reports failing when the rename fails, not only the write', async () => {
    const disk = createDisk();

    disk.failRenames = true;

    const subject = store(disk, vi.fn());

    await subject.load();
    subject.update(() => sample);
    await subject.flush();

    expect(subject.writeHealth()).toBe('failing');
  });

  it('keeps reporting failing while every write keeps failing, though it warns once', async () => {
    const disk = createDisk();

    disk.failWrites = true;

    const onWarning = vi.fn();
    const subject = store(disk, onWarning);

    await subject.load();

    for (let index = 0; index < 5; index += 1) {
      subject.update(() => sample);
      await subject.flush();
      expect(subject.writeHealth()).toBe('failing');
    }

    // The log is throttled; the answer to "did that write happen?" is not.
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  it('returns to healthy once a write succeeds again', async () => {
    const disk = createDisk();

    disk.failWrites = true;

    const subject = store(disk, vi.fn());

    await subject.load();
    subject.update(() => sample);
    await subject.flush();
    expect(subject.writeHealth()).toBe('failing');

    disk.failWrites = false;
    subject.update(() => sample);
    await subject.flush();

    expect(subject.writeHealth()).toBe('ok');
  });

  it('does not call a write that found nothing to do a failure', async () => {
    const disk = createDisk();
    const subject = store(disk);

    await subject.load();
    await subject.flush();

    expect(subject.writeHealth()).toBe('ok');
    expect(disk.renames).toHaveLength(0);
  });

  it('warns once per kind of failure rather than on every write', async () => {
    const disk = createDisk();

    disk.failWrites = true;

    const onWarning = vi.fn();
    const subject = store(disk, onWarning);

    await subject.load();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      subject.update(() => sample);
      await subject.flush();
    }

    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  it('warns when an existing file cannot be read for a reason other than absence', async () => {
    const disk = createDisk();
    const onWarning = vi.fn();

    vi.spyOn(disk, 'readFile').mockRejectedValue(new Error('permission denied'));

    await expect(store(disk, onWarning).load()).resolves.toEqual(emptyReaderState());
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('could not be read'));
  });

  it('applies updates as pure transformations of the current state', async () => {
    const disk = createDisk();
    const subject = store(disk);

    await subject.load();
    subject.update(() => sample);
    subject.update((state) => ({ ...state, documents: [] }));

    expect(subject.current().documents).toEqual([]);
  });
});
