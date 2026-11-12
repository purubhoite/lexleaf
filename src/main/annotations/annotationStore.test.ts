import { describe, expect, it, vi } from 'vitest';

import { addHighlight, EMPTY_ANNOTATIONS, toggleBookmark } from '@core/annotations/annotations';

import {
  createAnnotationStore,
  exportAnnotations,
  isDocumentId,
  type AnnotationFileSystem,
} from './annotationStore';

const AT = '2026-11-12T10:00:00.000Z';
const FILE = 'data/annotations.json';

const some = addHighlight(EMPTY_ANNOTATIONS, {
  id: 'h1',
  page: 2,
  start: 4,
  end: 9,
  text: 'tidal',
  colour: 'yellow',
  at: AT,
});

interface Disk extends AnnotationFileSystem {
  readonly files: Map<string, string>;
}

const disk = (initial: Record<string, string> = {}): Disk => {
  const files = new Map(Object.entries(initial));

  return {
    files,
    read: (path) =>
      files.has(path)
        ? Promise.resolve(files.get(path) ?? '')
        : Promise.reject(new Error('missing')),
    write: (path, contents) => {
      files.set(path, contents);

      return Promise.resolve();
    },
    rename: (from, to) => {
      files.set(to, files.get(from) ?? '');
      files.delete(from);

      return Promise.resolve();
    },
  };
};

describe('the annotation store', () => {
  it('starts empty when there is no file, or the file is not readable', async () => {
    for (const fileSystem of [disk(), disk({ [FILE]: '{not json' }), disk({ [FILE]: '[]' })]) {
      const store = createAnnotationStore({ filePath: FILE, fileSystem });

      expect(await store.load('doc-1')).toStrictEqual(EMPTY_ANNOTATIONS);
    }
  });

  it('keeps what was saved, across a restart', async () => {
    const fileSystem = disk();
    const first = createAnnotationStore({ filePath: FILE, fileSystem });

    expect(await first.save('doc-1', 'Harbour.pdf', some)).toBe(true);

    const second = createAnnotationStore({ filePath: FILE, fileSystem });

    expect(await second.load('doc-1')).toStrictEqual(some);
    expect(await second.nameOf('doc-1')).toBe('Harbour.pdf');
    expect(await second.load('doc-2')).toStrictEqual(EMPTY_ANNOTATIONS);
  });

  it('writes through a temporary file, leaving none behind', async () => {
    const fileSystem = disk();
    const store = createAnnotationStore({ filePath: FILE, fileSystem });

    await store.save('doc-1', 'Harbour.pdf', some);

    expect([...fileSystem.files.keys()]).toStrictEqual([FILE]);
  });

  it('stores only what it understands of what the window sends', async () => {
    const fileSystem = disk();
    const store = createAnnotationStore({ filePath: FILE, fileSystem });

    await store.save('doc-1', 'Harbour.pdf', {
      ...some,
      bookmarks: [{ page: 'x' }],
      secret: 'sk-live',
      path: '/home/reader/x.pdf',
    });

    const written = fileSystem.files.get(FILE) ?? '';

    expect(written).not.toContain('sk-live');
    expect(written).not.toContain('/home/reader');
    expect(await store.load('doc-1')).toStrictEqual(some);
  });

  it('forgets a book whose last annotation was removed', async () => {
    const fileSystem = disk();
    const store = createAnnotationStore({ filePath: FILE, fileSystem });

    await store.save('doc-1', 'Harbour.pdf', some);
    await store.save('doc-1', 'Harbour.pdf', EMPTY_ANNOTATIONS);

    expect(JSON.parse(fileSystem.files.get(FILE) ?? '{}')).toStrictEqual({
      version: 1,
      documents: {},
    });
  });

  it('reports a write that failed, and still holds the change for this session', async () => {
    const fileSystem = disk();
    const onDiagnostic = vi.fn<(message: string) => void>();

    fileSystem.write = () => Promise.reject(new Error('disk full'));

    const store = createAnnotationStore({ filePath: FILE, fileSystem, onDiagnostic });

    expect(await store.save('doc-1', 'Harbour.pdf', some)).toBe(false);
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(await store.load('doc-1')).toStrictEqual(some);
  });

  it('accepts only identifiers that are safe to use as keys', () => {
    expect(isDocumentId('a1b2')).toBe(true);

    for (const bad of ['', '__proto__', 'constructor', 7, null, 'x'.repeat(201)]) {
      expect(isDocumentId(bad)).toBe(false);
    }
  });

  it('skips unsafe identifiers found in the file', async () => {
    const fileSystem = disk({
      [FILE]: `{"version":1,"documents":{"__proto__":${JSON.stringify(some)},"ok":${JSON.stringify(some)}}}`,
    });
    const store = createAnnotationStore({ filePath: FILE, fileSystem });

    expect(await store.load('ok')).toStrictEqual(some);
    expect(await store.load('__proto__')).toStrictEqual(EMPTY_ANNOTATIONS);
  });
});

describe('exporting a book\u2019s annotations', () => {
  const stored = async (): Promise<ReturnType<typeof createAnnotationStore>> => {
    const store = createAnnotationStore({ filePath: FILE, fileSystem: disk() });

    await store.save('doc-1', 'Harbour.pdf', toggleBookmark(some, 7, 'Chapter 1', AT));

    return store;
  };

  it('writes Markdown where the reader chose, named after the book', async () => {
    const write = vi.fn<(path: string, contents: string) => Promise<void>>(() => Promise.resolve());
    const chooseDestination = vi.fn<(name: string) => Promise<string | null>>(() =>
      Promise.resolve('out/notes.md'),
    );

    const outcome = await exportAnnotations('doc-1', {
      store: await stored(),
      chooseDestination,
      write,
    });

    expect(outcome).toStrictEqual({ status: 'exported', count: 2 });
    expect(chooseDestination).toHaveBeenCalledWith('Harbour - notes.md');
    expect(write.mock.calls[0]?.[0]).toBe('out/notes.md');
    expect(write.mock.calls[0]?.[1]).toContain('> tidal');
  });

  it('asks nothing when there is nothing to export', async () => {
    const chooseDestination = vi.fn<(name: string) => Promise<string | null>>();

    const outcome = await exportAnnotations('doc-9', {
      store: await stored(),
      chooseDestination,
      write: () => Promise.resolve(),
    });

    expect(outcome).toStrictEqual({ status: 'empty' });
    expect(chooseDestination).not.toHaveBeenCalled();
  });

  it('says so when the reader cancels, and when the write fails', async () => {
    const store = await stored();

    expect(
      await exportAnnotations('doc-1', {
        store,
        chooseDestination: () => Promise.resolve(null),
        write: () => Promise.resolve(),
      }),
    ).toStrictEqual({ status: 'cancelled' });

    expect(
      await exportAnnotations('doc-1', {
        store,
        chooseDestination: () => Promise.resolve('out/notes.md'),
        write: () => Promise.reject(new Error('read-only')),
      }),
    ).toStrictEqual({ status: 'failed' });
  });
});
