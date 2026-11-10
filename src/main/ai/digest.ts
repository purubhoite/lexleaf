import { createHash } from 'node:crypto';

import { canonicalContextEncoding } from '@core/ai/identity';

/**
 * The hashes the explanation feature needs, and nowhere else to compute them.
 *
 * Core defines *what* is hashed — the canonical context encoding and the
 * endpoint canonical form — and stays free of `node:crypto`; this module
 * does the arithmetic. Keeping the two apart is what lets the encoding be
 * asserted character by character in a pure test while the digest stays a
 * one-line call over it.
 */

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * The context hash, over the excerpt **and** the word's offset inside it.
 *
 * Lower-case hexadecimal, computed over the same characters that are sent
 * to the provider, so a stored row can always be matched against what was
 * actually asked (investigation section 7.1.1).
 */
export const contextHash = (context: string, contextWordStart: number): string =>
  sha256Hex(canonicalContextEncoding(context, contextWordStart));

/** How many hex characters of the endpoint digest identify a configuration. */
export const ENDPOINT_FINGERPRINT_LENGTH = 16;

/**
 * A short, stable fingerprint of a configured endpoint.
 *
 * The input is scheme, host, port and base path only — never a query
 * string, never a header and **never a credential**, so rotating a key
 * cannot orphan stored explanations and no stored row can be used to
 * recover one.
 */
export const endpointFingerprint = (canonicalEndpoint: string): string =>
  sha256Hex(canonicalEndpoint).slice(0, ENDPOINT_FINGERPRINT_LENGTH);
