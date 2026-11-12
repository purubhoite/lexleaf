import { err, ok } from '@core/result';
import type { LibraryPage, LibraryQuery, SavedWord } from '@core/vocabulary/types';
import { describe, expect, it, vi } from 'vitest';

import { exportVocabulary, type VocabularyExportOptions } from './vocabularyExport';

const word = (id: string): SavedWord => ({
  id,
  word: { raw: id, display: id, normalized: id, joinedAcrossLines: false },
  headword: id,
  resolvedBy: null,
  lookupStatus: 'found',
  shortDefinition: `definition of ${id}`,
  snapshot: null,
  source: null,
  occurrences: [],
  savedAt: '2026-11-10T09:00:00.000Z',
  occurrenceCount: 0,
});

/** A library served two words to a page, the way the real one pages. */
const libraryOf = (ids: readonly string[]) =>
  vi.fn((query: LibraryQuery) => {
    const start = query.cursor === null ? 0 : Number(query.cursor.sortKey);
    const next = start + 2;
    const page: LibraryPage = {
      items: ids.slice(start, next).map(word),
      nextCursor: next < ids.length ? { sortKey: String(next), id: 'cursor' } : null,
      unreadable: 0,
    };

    return ok(page);
  });

const setup = (
  list: VocabularyExportOptions['service']['list'],
  overrides: Partial<VocabularyExportOptions> = {},
) => {
  const chooseDestination = vi.fn((): Promise<string | null> =>
    Promise.resolve('/home/reader/words.csv'),
  );
  const write = vi.fn<(path: string, contents: string) => Promise<void>>(() => Promise.resolve());
  const onDiagnostic = vi.fn<(message: string) => void>();
  const options = {
    service: { list },
    chooseDestination,
    write,
    now: () => new Date('2026-11-12T08:00:00.000Z'),
    onDiagnostic,
    ...overrides,
  };

  return { ...options, written: write, said: onDiagnostic };
};

describe('exporting the vocabulary', () => {
  it('writes every saved word, across pages, to the chosen file', async () => {
    const options = setup(libraryOf(['anchor', 'berth', 'cable', 'davit', 'eddy']));

    await expect(exportVocabulary('csv', options)).resolves.toStrictEqual({
      status: 'exported',
      count: 5,
    });

    expect(options.chooseDestination).toHaveBeenCalledExactlyOnceWith(
      'lexleaf-vocabulary-2026-11-12.csv',
      'csv',
    );
    expect(options.write).toHaveBeenCalledOnce();

    const [path, contents] = options.written.mock.calls[0] ?? ['', ''];

    expect(path).toBe('/home/reader/words.csv');
    expect(contents.trimEnd().split('\r\n')).toHaveLength(6);
    expect(contents).toContain('eddy,eddy,,definition of eddy');
  });

  it('writes the Anki format when asked', async () => {
    const options = setup(libraryOf(['anchor']));

    await exportVocabulary('anki', options);

    const [, contents] = options.written.mock.calls[0] ?? ['', ''];

    expect(options.chooseDestination).toHaveBeenCalledWith(
      'lexleaf-vocabulary-2026-11-12.txt',
      'anki',
    );
    expect(contents.startsWith('#separator:tab\n')).toBe(true);
  });

  it('does not ask where to save an empty library', async () => {
    const options = setup(libraryOf([]));

    await expect(exportVocabulary('csv', options)).resolves.toStrictEqual({ status: 'empty' });
    expect(options.chooseDestination).not.toHaveBeenCalled();
    expect(options.write).not.toHaveBeenCalled();
  });

  it('writes nothing when the reader cancels', async () => {
    const options = setup(libraryOf(['anchor']), {
      chooseDestination: vi.fn(() => Promise.resolve(null)),
    });

    await expect(exportVocabulary('csv', options)).resolves.toStrictEqual({ status: 'cancelled' });
    expect(options.write).not.toHaveBeenCalled();
  });

  it('reports a library that cannot be read', async () => {
    const options = setup(() => err({ kind: 'unavailable', reason: 'unknown' } as never));

    await expect(exportVocabulary('csv', options)).resolves.toStrictEqual({ status: 'failed' });
    expect(options.chooseDestination).not.toHaveBeenCalled();
  });

  it('reports a file that cannot be written, without the path', async () => {
    const options = setup(libraryOf(['anchor']), {
      write: vi.fn(() => Promise.reject(new Error('EACCES: /home/reader/words.csv'))),
    });

    await expect(exportVocabulary('csv', options)).resolves.toStrictEqual({ status: 'failed' });
    expect(JSON.stringify(options.said.mock.calls)).not.toContain('/home/reader');
  });

  it('gives up on a cursor that never ends', async () => {
    const list = vi.fn(() =>
      ok<LibraryPage>({ items: [], nextCursor: { sortKey: '0', id: 'again' }, unreadable: 0 }),
    );
    const options = setup(list);

    await expect(exportVocabulary('csv', options)).resolves.toStrictEqual({ status: 'failed' });
    expect(list.mock.calls.length).toBeLessThanOrEqual(10_000);
  });
});
