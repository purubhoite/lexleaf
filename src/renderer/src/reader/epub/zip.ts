/**
 * Reading a zip archive, which is what an EPUB is.
 *
 * Only what an EPUB needs: the list of files from the directory at the end
 * of the archive, and each file either stored as it is or deflated. The
 * inflating is done by the browser's own decompressor, so no code from a
 * book is ever run and no library is added to do it.
 *
 * An archive is not trusted. A small file can claim to hold an enormous
 * one, so every limit here is enforced on what actually comes out, not on
 * what the archive says about itself.
 */

export interface ZipLimits {
  /** The most files an archive may list. */
  readonly maxEntries: number;
  /** The most bytes one file may unpack to. */
  readonly maxEntryBytes: number;
  /** The most bytes the whole archive may unpack to, over its lifetime. */
  readonly maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

export class ZipError extends Error {
  override readonly name = 'ZipError';
}

interface Entry {
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly headerOffset: number;
  readonly encrypted: boolean;
}

export interface ZipArchive {
  /** Every file's path, as written in the archive. */
  readonly names: readonly string[];
  has(name: string): boolean;
  /** The file's bytes. Fails for a missing, encrypted or over-large file. */
  read(name: string): Promise<Uint8Array>;
}

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/** Whether the bytes begin the way a zip archive does. */
export const looksLikeZip = (bytes: Uint8Array): boolean =>
  bytes.length > 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  bytes[2] === 0x03 &&
  bytes[3] === 0x04;

const inflate = async (data: Uint8Array, limit: number): Promise<Uint8Array> => {
  const source = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(data);
      controller.close();
    },
  });
  const stream = source.pipeThrough(
    new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > limit) {
      await reader.cancel();
      throw new ZipError('A file in the archive unpacks to more than is allowed.');
    }

    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
};

export const openZip = (bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipArchive => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8');

  // The directory's end record is at the very end, before an optional comment.
  let end = -1;

  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  }

  if (end < 0) {
    throw new ZipError('The archive has no directory.');
  }

  const count = view.getUint16(end + 10, true);
  const directoryOffset = view.getUint32(end + 16, true);

  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new ZipError('Archives in the zip64 format are not supported.');
  }

  if (count > limits.maxEntries) {
    throw new ZipError('The archive lists more files than is allowed.');
  }

  const entries = new Map<string, Entry>();
  let at = directoryOffset;

  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== DIRECTORY_ENTRY) {
      throw new ZipError('The archive directory is damaged.');
    }

    const flags = view.getUint16(at + 8, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    // A name ending in a slash is a folder; it has nothing to read.
    if (!name.endsWith('/')) {
      entries.set(name, {
        method: view.getUint16(at + 10, true),
        compressedSize: view.getUint32(at + 20, true),
        size: view.getUint32(at + 24, true),
        headerOffset: view.getUint32(at + 42, true),
        encrypted: (flags & 1) !== 0,
      });
    }

    at += 46 + nameLength + extraLength + commentLength;
  }

  let unpacked = 0;

  return {
    names: [...entries.keys()],

    has: (name: string): boolean => entries.has(name),

    async read(name: string): Promise<Uint8Array> {
      const entry = entries.get(name);

      if (entry === undefined) {
        throw new ZipError(`The archive has no file named ${name}.`);
      }

      if (entry.encrypted) {
        throw new ZipError('The archive is password-protected.');
      }

      const header = entry.headerOffset;

      if (header + 30 > bytes.length || view.getUint32(header, true) !== LOCAL_HEADER) {
        throw new ZipError('The archive is damaged.');
      }

      const start =
        header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
      const stop = start + entry.compressedSize;

      if (stop > bytes.length) {
        throw new ZipError('The archive is cut short.');
      }

      const budget = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - unpacked);
      const data = bytes.subarray(start, stop);
      let out: Uint8Array;

      if (entry.method === STORED) {
        if (data.byteLength > budget) {
          throw new ZipError('A file in the archive is larger than is allowed.');
        }

        out = data.slice();
      } else if (entry.method === DEFLATED) {
        out = await inflate(data, budget);
      } else {
        throw new ZipError('The archive uses a compression method that is not supported.');
      }

      unpacked += out.byteLength;

      return out;
    },
  };
};
