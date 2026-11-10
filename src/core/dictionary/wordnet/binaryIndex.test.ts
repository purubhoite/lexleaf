import { describe, expect, it } from 'vitest';

import {
  DictionaryArtifactError,
  INDEX_HEADER_BYTES,
  INDEX_RECORD_BYTES,
  readDictionaryIndex,
} from './binaryIndex';

/**
 * The index is validated against bytes written here rather than against a
 * file produced by the build script, so this test states the format
 * independently: if the two ever disagree, one of them is wrong and the
 * fixture test in `src/main/dictionary` says which.
 */

interface Record {
  readonly key: string;
  readonly valueOffset: number;
  readonly valueLength: number;
}

const encoder = new TextEncoder();

const buildIndex = (
  records: readonly Record[],
  overrides: { magic?: number; version?: number; count?: number; keyBlobLength?: number } = {},
): Uint8Array => {
  const keys = records.map((record) => encoder.encode(record.key));
  const keyBlobLength = keys.reduce((total, key) => total + key.length, 0);
  const bytes = new Uint8Array(
    INDEX_HEADER_BYTES + records.length * INDEX_RECORD_BYTES + keyBlobLength,
  );
  const view = new DataView(bytes.buffer);

  view.setUint32(0, overrides.magic ?? 0x44525049, true);
  view.setUint32(4, overrides.version ?? 1, true);
  view.setUint32(8, overrides.count ?? records.length, true);
  view.setUint32(12, overrides.keyBlobLength ?? keyBlobLength, true);

  let keyOffset = 0;

  records.forEach((record, position) => {
    const at = INDEX_HEADER_BYTES + position * INDEX_RECORD_BYTES;
    const key = keys[position] ?? new Uint8Array();

    view.setUint32(at, keyOffset, true);
    view.setUint32(at + 4, key.length, true);
    view.setUint32(at + 8, record.valueOffset, true);
    view.setUint32(at + 12, record.valueLength, true);

    bytes.set(key, INDEX_HEADER_BYTES + records.length * INDEX_RECORD_BYTES + keyOffset);
    keyOffset += key.length;
  });

  return bytes;
};

const sorted: readonly Record[] = [
  { key: 'alpha', valueOffset: 0, valueLength: 10 },
  { key: 'beta', valueOffset: 10, valueLength: 5 },
  { key: 'gamma', valueOffset: 15, valueLength: 7 },
  { key: 'ʒ', valueOffset: 22, valueLength: 3 },
];

describe('binary index', () => {
  it('finds every key it contains', () => {
    const index = readDictionaryIndex(buildIndex(sorted), 32);

    expect(index.count).toBe(4);

    for (const record of sorted) {
      expect(index.find(record.key)).toEqual({
        valueOffset: record.valueOffset,
        valueLength: record.valueLength,
      });
    }
  });

  it('returns null for a key it does not contain', () => {
    const index = readDictionaryIndex(buildIndex(sorted), 32);

    for (const missing of ['', 'a', 'alphabet', 'zzz', 'Beta']) {
      expect(index.find(missing)).toBeNull();
    }
  });

  it('reads keys back by position', () => {
    const index = readDictionaryIndex(buildIndex(sorted), 32);

    expect(index.keyAt(0)).toBe('alpha');
    expect(index.keyAt(3)).toBe('ʒ');
    expect(() => index.keyAt(4)).toThrow(DictionaryArtifactError);
  });

  it.each([
    ['a file shorter than the header', (): Uint8Array => new Uint8Array(8)],
    ['the wrong magic number', (): Uint8Array => buildIndex(sorted, { magic: 0x11111111 })],
    ['an unsupported version', (): Uint8Array => buildIndex(sorted, { version: 2 })],
    ['a record count that does not fit', (): Uint8Array => buildIndex(sorted, { count: 99 })],
    [
      'a key blob length that does not fit',
      (): Uint8Array => buildIndex(sorted, { keyBlobLength: 4 }),
    ],
    ['a truncated file', (): Uint8Array => buildIndex(sorted).subarray(0, INDEX_HEADER_BYTES + 4)],
  ])('refuses %s', (_name, make) => {
    expect(() => readDictionaryIndex(make(), 32)).toThrow(DictionaryArtifactError);
  });

  it('refuses a record that points outside the payload', () => {
    const bytes = buildIndex([{ key: 'alpha', valueOffset: 0, valueLength: 100 }]);

    expect(() => readDictionaryIndex(bytes, 32)).toThrow(/outside the payload/u);
  });

  it('refuses keys that are not in ascending byte order', () => {
    const bytes = buildIndex([
      { key: 'beta', valueOffset: 0, valueLength: 2 },
      { key: 'alpha', valueOffset: 2, valueLength: 2 },
    ]);

    expect(() => readDictionaryIndex(bytes, 32)).toThrow(/ascending byte order/u);
  });

  it('refuses a duplicated key', () => {
    const bytes = buildIndex([
      { key: 'alpha', valueOffset: 0, valueLength: 2 },
      { key: 'alpha', valueOffset: 2, valueLength: 2 },
    ]);

    expect(() => readDictionaryIndex(bytes, 32)).toThrow(DictionaryArtifactError);
  });

  it('reports corruption without leaking a path or an errno', () => {
    try {
      readDictionaryIndex(new Uint8Array(8), 0);
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DictionaryArtifactError);
      expect((error as DictionaryArtifactError).reason).toBe('corrupt');
      expect(JSON.stringify(error)).not.toMatch(/\//u);
    }
  });

  it('handles an empty index', () => {
    const index = readDictionaryIndex(buildIndex([]), 0);

    expect(index.count).toBe(0);
    expect(index.find('alpha')).toBeNull();
  });
});
