import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { DictionaryArtifactError } from '@core/dictionary/wordnet/binaryIndex';
import type {
  DictionaryArtifact,
  RandomAccessBytes,
} from '@core/dictionary/wordnet/wordNetFileProvider';

/**
 * The filesystem behind the dictionary provider.
 *
 * This is the only module in the dictionary subsystem that touches files.
 * The core adapter is handed bytes, so it stays testable without a
 * filesystem and free of a runtime (ADR-012).
 *
 * The index, the manifest and the morphology tables are read whole at open —
 * together about 4.3 MB — and the 27 MB payload is left on disk and read by
 * byte range. Failures are translated here into the closed reason set the
 * renderer is allowed to see; the message, the path and the `errno` stay in
 * the main process.
 */

export const INDEX_FILE = 'entries.idx';
export const PAYLOAD_FILE = 'entries.jsonl';
export const MANIFEST_FILE = 'manifest.json';
export const MORPHOLOGY_FILE = 'morphology.json';
export const NOTICE_FILE = 'NOTICE.md';

interface NodeError {
  readonly code?: string;
}

const reasonFor = (error: unknown): 'not-installed' | 'unreadable' => {
  const code = (error as NodeError | null)?.code;

  return code === 'ENOENT' ? 'not-installed' : 'unreadable';
};

const fail = (error: unknown, what: string): never => {
  throw new DictionaryArtifactError(
    reasonFor(error),
    `${what}: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
};

/** Positional reads over an open file descriptor. */
const openPayload = (path: string): RandomAccessBytes & { close: () => void } => {
  let descriptor: number;
  let size: number;

  try {
    descriptor = openSync(path, 'r');
    size = statSync(path).size;
  } catch (error: unknown) {
    return fail(error, 'could not open the dictionary payload');
  }

  return {
    size,

    read(offset: number, length: number): Uint8Array {
      if (offset < 0 || length < 0 || offset + length > size) {
        throw new DictionaryArtifactError('corrupt', 'payload read outside the file');
      }

      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(descriptor, buffer, 0, length, offset);

      if (read !== length) {
        throw new DictionaryArtifactError('unreadable', 'short read from the dictionary payload');
      }

      return buffer;
    },

    close(): void {
      try {
        closeSync(descriptor);
      } catch {
        // Closing a descriptor that is already gone is not a user-visible
        // failure; there is nothing left to release either way.
      }
    },
  };
};

/**
 * Opens the artifact in a directory.
 *
 * @throws DictionaryArtifactError with a reason from the closed set
 */
export const openFileArtifact = (directory: string): DictionaryArtifact => {
  let index: Uint8Array;
  let manifestText: string;
  let morphologyText: string;

  try {
    index = readFileSync(join(directory, INDEX_FILE));
  } catch (error: unknown) {
    return fail(error, 'could not read the dictionary index');
  }

  try {
    manifestText = readFileSync(join(directory, MANIFEST_FILE), 'utf8');
  } catch (error: unknown) {
    return fail(error, 'could not read the dictionary manifest');
  }

  try {
    morphologyText = readFileSync(join(directory, MORPHOLOGY_FILE), 'utf8');
  } catch (error: unknown) {
    return fail(error, 'could not read the dictionary morphology tables');
  }

  const payload = openPayload(join(directory, PAYLOAD_FILE));

  return {
    index,
    payload,
    manifestText,
    morphologyText,
    close: payload.close,
  };
};
