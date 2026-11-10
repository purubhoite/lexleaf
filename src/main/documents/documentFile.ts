import { basename } from 'node:path';

import type { DocumentFailureReason, DocumentRequestResult } from '@shared/ipc/contracts';

import { computeDocumentId } from './documentIdentity';

/**
 * Reading a document from disk.
 *
 * The filesystem access is injected so the rules (size limit, file type,
 * failure classification) can be tested without touching a real disk, and so
 * the main process keeps a single place where a path becomes bytes.
 *
 * This is also the place where a failure stops being a filesystem event and
 * becomes a product fact (M7.2, ADR-034). Before M7.2 the `catch` below
 * returned `error.message`, which carried the `errno` and the absolute path
 * into the renderer and onto the screen (M7 investigation R2). It now
 * returns one of five closed reason codes; the operating system's own words
 * are handed to `onDiagnostic`, which the main process points at its log.
 *
 * Nothing that leaves this function can hold a path: the result carries a
 * reason drawn from a union and, at most, the file's own scrubbed name.
 */

/** Documents larger than this are refused rather than loaded into memory. */
export const MAX_DOCUMENT_BYTES = 256 * 1024 * 1024;

/** Long enough for any real document name, short enough not to be a payload. */
const MAX_NAME_LENGTH = 120;

export interface FileSystemAccess {
  stat(path: string): Promise<{ readonly size: number; readonly isFile: () => boolean }>;
  readFile(path: string): Promise<Uint8Array>;
}

export interface ReadDocumentOptions {
  /**
   * Where the detail goes instead of to the reader: the `errno`, the
   * message, the path. Optional so that a caller which does not log still
   * gets the same closed result rather than a different one.
   */
  readonly onDiagnostic?: (message: string) => void;
}

/**
 * The file's own name, with anything resembling a location removed.
 *
 * `basename` already drops everything up to the last `/`, which is the
 * whole of the leak that mattered. The rest is defence in depth rather
 * than the defence itself (the closed reason type is that): a backslash
 * is a legal character in a POSIX file name and a Windows separator, so
 * it goes; control characters go because a name is rendered; and the
 * length is capped so a pathological name cannot become a wall of text in
 * the failure screen.
 */
export const displayName = (path: string): string =>
  basename(path)
    // eslint-disable-next-line no-control-regex -- a rendered name may not carry control characters
    .replace(/[\\/\u0000-\u001f\u007f]/gu, '')
    .slice(0, MAX_NAME_LENGTH);

/** The `errno` of a rejected filesystem call, when there is one. */
const errorCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;

  return typeof code === 'string' ? code : null;
};

/**
 * One `errno` mapped to one product reason.
 *
 * Only codes whose meaning is unambiguous to a *reader* are translated.
 * Everything else is `unknown`, which is honest: "something went wrong
 * with that file" is all the application can truthfully say, and inventing
 * a more specific sentence from a code it does not recognise would be
 * worse than saying less.
 */
const REASON_BY_CODE: Readonly<Record<string, DocumentFailureReason>> = {
  ENOENT: 'missing',
  ENOTDIR: 'missing',
  EACCES: 'unreadable',
  EPERM: 'unreadable',
  EISDIR: 'not-a-file',
  EFBIG: 'too-large',
  EBUSY: 'unreadable',
  EIO: 'unreadable',
  ENXIO: 'unreadable',
};

export const classifyReadFailure = (error: unknown): DocumentFailureReason => {
  const code = errorCode(error);

  return (code === null ? undefined : REASON_BY_CODE[code]) ?? 'unknown';
};

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export const readDocumentFile = async (
  path: string,
  fileSystem: FileSystemAccess,
  { onDiagnostic }: ReadDocumentOptions = {},
): Promise<DocumentRequestResult> => {
  const name = displayName(path);

  /** The one place a failure is assembled, so none of them can differ. */
  const failed = (reason: DocumentFailureReason, detail: string): DocumentRequestResult => {
    // The path is in the diagnostic deliberately: this string goes to the
    // main-process log, which is where someone diagnosing the failure
    // needs it, and it is the only copy of it that exists.
    onDiagnostic?.(`could not open ${path}: ${reason} (${detail})`);

    return { status: 'unreadable', reason, name: name === '' ? null : name };
  };

  try {
    const stats = await fileSystem.stat(path);

    if (!stats.isFile()) {
      return failed('not-a-file', 'stat reports the path is not a regular file');
    }

    if (stats.size > MAX_DOCUMENT_BYTES) {
      return failed(
        'too-large',
        `${String(stats.size)} bytes exceeds the ${String(MAX_DOCUMENT_BYTES)} byte limit`,
      );
    }

    const bytes = await fileSystem.readFile(path);

    return {
      status: 'opened',
      document: {
        id: computeDocumentId(bytes),
        name: basename(path),
        sizeBytes: bytes.byteLength,
        bytes,
        // Reading state is attached by the service that owns it; reading a
        // file knows nothing about where the reader stopped last time.
        position: null,
      },
    };
  } catch (error) {
    return failed(classifyReadFailure(error), describe(error));
  }
};
