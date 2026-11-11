import { describe, expect, it, vi } from 'vitest';

import { DOCUMENT_FAILURE_REASONS } from '@shared/ipc/contracts';

import {
  MAX_DOCUMENT_BYTES,
  classifyReadFailure,
  displayName,
  readDocumentFile,
  type FileSystemAccess,
} from './documentFile';
import { computeDocumentId } from './documentIdentity';

const fileSystem = (overrides: Partial<FileSystemAccess> = {}): FileSystemAccess => ({
  stat: () => Promise.resolve({ size: 1024, isFile: (): boolean => true }),
  readFile: () => Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
  ...overrides,
});

/** A rejection shaped like Node's: a message with the path in it, and a code. */
const errno = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });

const rejecting = (error: unknown, where: 'stat' | 'readFile' = 'stat'): FileSystemAccess =>
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- one of these tests rejects with a string on purpose: a driver that throws a non-Error must still classify
  fileSystem({ [where]: () => Promise.reject(error) });

describe('readDocumentFile', () => {
  it('returns the bytes and the file name', async () => {
    const result = await readDocumentFile('/books/harbour.pdf', fileSystem());

    expect(result).toEqual({
      status: 'opened',
      document: {
        id: computeDocumentId(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
        name: 'harbour.pdf',
        sizeBytes: 4,
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        position: null,
      },
    });
  });

  it('does not expose the filesystem path to the caller', async () => {
    const result = await readDocumentFile('/private/books/harbour.pdf', fileSystem());

    expect(JSON.stringify(result)).not.toContain('/private/books');
  });

  /* ---------------------------------------------------------------- *
   * The five reasons (M7.2)
   * ---------------------------------------------------------------- */

  it('reports a missing file as `missing`, not as the exception it caught', async () => {
    const result = await readDocumentFile(
      '/private/books/gone.pdf',
      rejecting(
        errno('ENOENT', "ENOENT: no such file or directory, stat '/private/books/gone.pdf'"),
      ),
    );

    expect(result).toEqual({ status: 'unreadable', reason: 'missing', name: 'gone.pdf' });
  });

  it('reports a file it may not read as `unreadable`', async () => {
    const result = await readDocumentFile(
      '/vault/Tax Return 2025.pdf',
      rejecting(
        errno('EACCES', "EACCES: permission denied, open '/vault/Tax Return 2025.pdf'"),
        'readFile',
      ),
    );

    expect(result).toEqual({
      status: 'unreadable',
      reason: 'unreadable',
      name: 'Tax Return 2025.pdf',
    });
  });

  it('refuses a directory as `not-a-file`', async () => {
    const result = await readDocumentFile(
      '/books',
      fileSystem({ stat: () => Promise.resolve({ size: 0, isFile: (): boolean => false }) }),
    );

    expect(result).toEqual({ status: 'unreadable', reason: 'not-a-file', name: 'books' });
  });

  it('refuses a file beyond the size limit as `too-large`', async () => {
    const result = await readDocumentFile(
      '/books/huge.pdf',
      fileSystem({
        stat: () => Promise.resolve({ size: MAX_DOCUMENT_BYTES + 1, isFile: (): boolean => true }),
      }),
    );

    expect(result).toEqual({ status: 'unreadable', reason: 'too-large', name: 'huge.pdf' });
  });

  it('accepts a file exactly at the limit, so the boundary is not off by one', async () => {
    const result = await readDocumentFile(
      '/books/exactly.pdf',
      fileSystem({
        stat: () => Promise.resolve({ size: MAX_DOCUMENT_BYTES, isFile: (): boolean => true }),
      }),
    );

    expect(result.status).toBe('opened');
  });

  it('reports an unrecognised filesystem failure as `unknown`', async () => {
    const result = await readDocumentFile(
      '/books/odd.pdf',
      rejecting(errno('ELOOP', "ELOOP: too many symbolic links, stat '/books/odd.pdf'")),
    );

    expect(result).toEqual({ status: 'unreadable', reason: 'unknown', name: 'odd.pdf' });
  });

  it('survives a rejection that is not an Error at all', async () => {
    const result = await readDocumentFile('/books/odd.pdf', rejecting('something went wrong'));

    expect(result).toEqual({ status: 'unreadable', reason: 'unknown', name: 'odd.pdf' });
  });

  it('answers with a reason from the closed set whatever the filesystem does', async () => {
    const codes = ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'EIO', 'EMFILE', 'EBADF', 'ENOTDIR'];

    for (const code of codes) {
      const result = await readDocumentFile(
        '/books/a.pdf',
        rejecting(errno(code, `${code}: something, open '/books/a.pdf'`)),
      );

      expect(result.status).toBe('unreadable');
      expect(result.status === 'unreadable' && DOCUMENT_FAILURE_REASONS).toContain(
        result.status === 'unreadable' ? result.reason : 'not-a-reason',
      );
    }
  });

  /* ---------------------------------------------------------------- *
   * Nothing raw escapes (M7.2 security contract)
   * ---------------------------------------------------------------- */

  it('lets no path, errno or exception text into the result', async () => {
    const failures: readonly (readonly [string, unknown, 'stat' | 'readFile'])[] = [
      [
        '/home/reader/private/Medical Report 2026.pdf',
        errno(
          'ENOENT',
          "ENOENT: no such file or directory, stat '/home/reader/private/Medical Report 2026.pdf'",
        ),
        'stat',
      ],
      [
        'C:\\Users\\reader\\Divorce Papers.pdf',
        errno('EACCES', "EACCES: permission denied, open 'C:\\Users\\reader\\Divorce Papers.pdf'"),
        'readFile',
      ],
      ['/mnt/share/book.pdf', new TypeError('fetch failed: file:///mnt/share/book.pdf'), 'stat'],
    ];

    for (const [path, error, where] of failures) {
      const serialised = JSON.stringify(await readDocumentFile(path, rejecting(error, where)));

      for (const forbidden of ['/', '\\', 'ENOENT', 'EACCES', 'file://', 'Error', 'permission']) {
        expect({ path, forbidden, serialised }).toStrictEqual({
          path,
          forbidden,
          serialised: expect.not.stringContaining(forbidden) as string,
        });
      }
    }
  });

  it('sends the detail to the diagnostic log instead, path and all', async () => {
    const onDiagnostic = vi.fn();

    await readDocumentFile(
      '/private/books/gone.pdf',
      rejecting(
        errno('ENOENT', "ENOENT: no such file or directory, stat '/private/books/gone.pdf'"),
      ),
      { onDiagnostic },
    );

    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    const [message] = onDiagnostic.mock.calls[0] as [string];

    // The things the reader may not see are exactly the things the person
    // diagnosing the failure needs, so they are here and only here.
    expect(message).toContain('/private/books/gone.pdf');
    expect(message).toContain('ENOENT');
    expect(message).toContain('missing');
  });

  it('logs the refusals it decides itself, not only the ones it catches', async () => {
    const onDiagnostic = vi.fn();

    await readDocumentFile(
      '/books',
      fileSystem({ stat: () => Promise.resolve({ size: 0, isFile: (): boolean => false }) }),
      { onDiagnostic },
    );
    await readDocumentFile(
      '/books/huge.pdf',
      fileSystem({
        stat: () => Promise.resolve({ size: MAX_DOCUMENT_BYTES + 1, isFile: (): boolean => true }),
      }),
      { onDiagnostic },
    );

    expect(onDiagnostic.mock.calls.map(([message]) => message as string)).toEqual([
      expect.stringContaining('not-a-file') as string,
      expect.stringContaining('too-large') as string,
    ]);
  });

  it('says nothing to the log when an open succeeds', async () => {
    const onDiagnostic = vi.fn();

    await readDocumentFile('/books/harbour.pdf', fileSystem(), { onDiagnostic });

    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  it('classifies without a disk, so the mapping itself can be read', () => {
    expect(classifyReadFailure(errno('ENOENT', 'x'))).toBe('missing');
    expect(classifyReadFailure(errno('EACCES', 'x'))).toBe('unreadable');
    expect(classifyReadFailure(errno('EISDIR', 'x'))).toBe('not-a-file');
    expect(classifyReadFailure(errno('EWHATEVER', 'x'))).toBe('unknown');
    expect(classifyReadFailure(new Error('no code at all'))).toBe('unknown');
    expect(classifyReadFailure(null)).toBe('unknown');
  });
});

describe('displayName', () => {
  it('keeps the file name and drops the directories', () => {
    expect(displayName('/home/reader/private/book.pdf')).toBe('book.pdf');
  });

  it('removes a separator that survived basename, wherever it came from', () => {
    // Legal in a POSIX file name, and a directory separator on Windows.
    expect(displayName('/books/odd\\name.pdf')).toBe('oddname.pdf');
    expect(displayName('C:\\Users\\reader\\book.pdf')).toBe('book.pdf');
  });

  it('removes control characters, which have no business being rendered', () => {
    expect(displayName('/books/line\nbreak\u0000.pdf')).toBe('linebreak.pdf');
  });

  it('caps a pathological name rather than rendering a wall of text', () => {
    expect(displayName(`/books/${'a'.repeat(500)}.pdf`)).toHaveLength(120);
  });

  it('is empty when there is nothing left to show', () => {
    expect(displayName('/')).toBe('');
  });
});
