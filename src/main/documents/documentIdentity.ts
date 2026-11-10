import { createHash } from 'node:crypto';

/**
 * Identity of a document, derived from its contents rather than its path.
 *
 * A reading position belongs to a *document*, not to a filename. Deriving
 * identity from the bytes means a file that the user moved or renamed is
 * still recognised, while a file that was replaced with a different document
 * at the same path is correctly treated as new — so the reader is never
 * restored to page 180 of a document that no longer has one (ADR-016).
 *
 * The whole file is deliberately not hashed: at the 256 MB limit that costs
 * real time on every open. The size plus the first and last mebibyte
 * distinguish documents in every realistic case, and a collision would mean
 * two files of identical length whose first and last megabytes are identical
 * byte for byte.
 */

/** Bytes sampled from each end of the file. */
export const IDENTITY_SAMPLE_BYTES = 1024 * 1024;

export const computeDocumentId = (bytes: Uint8Array): string => {
  const hash = createHash('sha256');

  hash.update(`pdf:${String(bytes.byteLength)}:`);
  hash.update(bytes.subarray(0, IDENTITY_SAMPLE_BYTES));

  if (bytes.byteLength > IDENTITY_SAMPLE_BYTES) {
    hash.update(
      bytes.subarray(Math.max(IDENTITY_SAMPLE_BYTES, bytes.byteLength - IDENTITY_SAMPLE_BYTES)),
    );
  }

  return hash.digest('hex');
};
