import type { DictionaryUnavailableReason } from '../types';

/**
 * The dictionary index file.
 *
 * The payload is a JSONL file, one entry per line, and this is the table
 * that says where each line is. Keeping the index resident (about 4 MB) and
 * the payload on disk is what gives a sub-millisecond lookup without holding
 * a 25 MB string in memory (ADR-019, measured in docs/DICTIONARY_INVESTIGATION.md).
 *
 * Layout, little endian throughout:
 *
 * ```text
 * magic   u32   'IPRD' as four ASCII bytes
 * version u32   format version, currently 1
 * count   u32   number of records
 * keyBlob u32   length in bytes of the key blob
 * records count * { keyOffset u32, keyLength u32, valueOffset u32, valueLength u32 }
 * keys    UTF-8, concatenated, sorted by byte order
 * ```
 *
 * The file is read as untrusted input even though the application produced
 * it: a truncated download, a half-written file or a corrupted install must
 * end in a reported `unavailable`, never in a crash or in a definition read
 * from the wrong offset.
 */

/** `IPRD`, little endian. */
export const INDEX_MAGIC = 0x44525049;
export const INDEX_VERSION = 1;
export const INDEX_HEADER_BYTES = 16;
export const INDEX_RECORD_BYTES = 16;

/** Raised when an artifact cannot be used. Carries no path and no `errno`. */
export class DictionaryArtifactError extends Error {
  public readonly reason: DictionaryUnavailableReason;

  public constructor(reason: DictionaryUnavailableReason, detail: string) {
    super(detail);
    this.name = 'DictionaryArtifactError';
    this.reason = reason;
  }
}

export interface IndexRecord {
  readonly valueOffset: number;
  readonly valueLength: number;
}

export interface DictionaryIndex {
  readonly count: number;
  /** The record for an exact key, or `null`. */
  find(key: string): IndexRecord | null;
  /** The key at a position, for tests and diagnostics. */
  keyAt(position: number): string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/** Byte-order comparison, the same order the build script sorts keys in. */
const compareBytes = (
  left: Uint8Array,
  leftStart: number,
  leftLength: number,
  right: Uint8Array,
): number => {
  const shared = Math.min(leftLength, right.length);

  for (let offset = 0; offset < shared; offset += 1) {
    const difference = (left[leftStart + offset] ?? 0) - (right[offset] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return leftLength - right.length;
};

const corrupt = (detail: string): DictionaryArtifactError =>
  new DictionaryArtifactError('corrupt', detail);

/**
 * Validates an index and returns a searchable view of it.
 *
 * @param bytes the whole index file
 * @param payloadBytes size of the payload file the records point into
 * @throws DictionaryArtifactError when anything about the file is wrong
 */
export const readDictionaryIndex = (bytes: Uint8Array, payloadBytes: number): DictionaryIndex => {
  if (bytes.byteLength < INDEX_HEADER_BYTES) {
    throw corrupt('index shorter than its header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);

  if (magic !== INDEX_MAGIC) {
    throw corrupt('index magic number does not match');
  }

  const version = view.getUint32(4, true);

  if (version !== INDEX_VERSION) {
    throw corrupt(`unsupported index version ${String(version)}`);
  }

  const count = view.getUint32(8, true);
  const keyBlobLength = view.getUint32(12, true);
  const tableBytes = count * INDEX_RECORD_BYTES;
  const expected = INDEX_HEADER_BYTES + tableBytes + keyBlobLength;

  if (expected !== bytes.byteLength) {
    throw corrupt('index length does not match its header');
  }

  const keyBlobStart = INDEX_HEADER_BYTES + tableBytes;

  // Every record is bounds-checked once, at open, so that a lookup can read
  // a byte range without re-validating it and without ever reading outside
  // the payload.
  let previousStart = -1;
  let previousLength = -1;

  for (let position = 0; position < count; position += 1) {
    const record = INDEX_HEADER_BYTES + position * INDEX_RECORD_BYTES;
    const keyOffset = view.getUint32(record, true);
    const keyLength = view.getUint32(record + 4, true);
    const valueOffset = view.getUint32(record + 8, true);
    const valueLength = view.getUint32(record + 12, true);

    if (keyLength === 0 || keyOffset + keyLength > keyBlobLength) {
      throw corrupt('index key range outside the key blob');
    }

    if (valueLength === 0 || valueOffset + valueLength > payloadBytes) {
      throw corrupt('index value range outside the payload');
    }

    if (previousStart >= 0) {
      const order = compareBytes(
        bytes,
        keyBlobStart + previousStart,
        previousLength,
        bytes.subarray(keyBlobStart + keyOffset, keyBlobStart + keyOffset + keyLength),
      );

      if (order >= 0) {
        throw corrupt('index keys are not in strictly ascending byte order');
      }
    }

    previousStart = keyOffset;
    previousLength = keyLength;
  }

  const recordAt = (position: number): { keyOffset: number; keyLength: number } & IndexRecord => {
    const record = INDEX_HEADER_BYTES + position * INDEX_RECORD_BYTES;

    return {
      keyOffset: view.getUint32(record, true),
      keyLength: view.getUint32(record + 4, true),
      valueOffset: view.getUint32(record + 8, true),
      valueLength: view.getUint32(record + 12, true),
    };
  };

  return {
    count,

    find(key: string): IndexRecord | null {
      const wanted = encoder.encode(key);
      let low = 0;
      let high = count - 1;

      while (low <= high) {
        const middle = (low + high) >> 1;
        const record = recordAt(middle);
        const order = compareBytes(
          bytes,
          keyBlobStart + record.keyOffset,
          record.keyLength,
          wanted,
        );

        if (order === 0) {
          return { valueOffset: record.valueOffset, valueLength: record.valueLength };
        }

        if (order < 0) {
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }

      return null;
    },

    keyAt(position: number): string {
      if (position < 0 || position >= count) {
        throw corrupt('index position out of range');
      }

      const record = recordAt(position);

      return decoder.decode(
        bytes.subarray(
          keyBlobStart + record.keyOffset,
          keyBlobStart + record.keyOffset + record.keyLength,
        ),
      );
    },
  };
};
