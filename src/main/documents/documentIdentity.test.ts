import { describe, expect, it } from 'vitest';

import { computeDocumentId, IDENTITY_SAMPLE_BYTES } from './documentIdentity';

const bytes = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill);

describe('document identity', () => {
  it('is stable for the same contents', () => {
    const contents = bytes(2_048, 7);

    expect(computeDocumentId(contents)).toBe(computeDocumentId(bytes(2_048, 7)));
  });

  it('is a hex digest, not a path', () => {
    expect(computeDocumentId(bytes(16, 1))).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('differs when the contents differ', () => {
    expect(computeDocumentId(bytes(1_024, 1))).not.toBe(computeDocumentId(bytes(1_024, 2)));
  });

  it('differs when only the length differs', () => {
    expect(computeDocumentId(bytes(1_024, 1))).not.toBe(computeDocumentId(bytes(1_025, 1)));
  });

  it('does not depend on where the file is, because it never sees a path', () => {
    const contents = bytes(64, 3);

    // Two copies of the same document in different folders are the same
    // document; identity is computed from these bytes alone.
    expect(computeDocumentId(contents)).toBe(computeDocumentId(contents.slice()));
  });

  it('notices a change in the first sampled megabyte', () => {
    const original = bytes(IDENTITY_SAMPLE_BYTES * 3, 0);
    const edited = original.slice();

    edited[10] = 1;

    expect(computeDocumentId(edited)).not.toBe(computeDocumentId(original));
  });

  it('notices a change in the last sampled megabyte', () => {
    const original = bytes(IDENTITY_SAMPLE_BYTES * 3, 0);
    const edited = original.slice();

    edited[original.length - 10] = 1;

    expect(computeDocumentId(edited)).not.toBe(computeDocumentId(original));
  });

  it('handles an empty file without throwing', () => {
    expect(computeDocumentId(new Uint8Array(0))).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('samples rather than hashing everything, so a large file stays cheap', () => {
    const large = bytes(IDENTITY_SAMPLE_BYTES * 8, 0);
    const started = performance.now();

    computeDocumentId(large);

    // Generous: the point is that the cost does not grow with the whole file.
    expect(performance.now() - started).toBeLessThan(250);
  });
});
