import { describe, expect, it } from 'vitest';

import { ENDPOINT_FINGERPRINT_LENGTH, contextHash, endpointFingerprint } from './digest';

describe('the context hash', () => {
  it('is lower-case hexadecimal of the full digest', () => {
    expect(contextHash('a charge here', 2)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('reproduces the same digest for the same excerpt and offset', () => {
    expect(contextHash('the capacitor holds a charge', 22)).toBe(
      contextHash('the capacitor holds a charge', 22),
    );
  });

  it('differs when only the offset differs', () => {
    const excerpt = 'charge the charge and then charge again';

    expect(contextHash(excerpt, 0)).not.toBe(contextHash(excerpt, 11));
  });

  it('differs when only the excerpt differs', () => {
    expect(contextHash('one text', 0)).not.toBe(contextHash('one texts', 0));
  });

  it('is the digest of the canonical encoding, pinned', () => {
    // Recorded so that a change to the encoding cannot pass unnoticed:
    // SHA-256 of "v1\n2\n13\na charge here".
    expect(contextHash('a charge here', 2)).toBe(
      '70743d0522497fb672a84e8cfc7b2314b57dd1726146d050150b3379ec79f3f5',
    );
  });
});

describe('the endpoint fingerprint', () => {
  it('is a short hexadecimal string', () => {
    expect(endpointFingerprint('https://api.example.com:443/v1')).toMatch(
      new RegExp(`^[0-9a-f]{${String(ENDPOINT_FINGERPRINT_LENGTH)}}$`, 'u'),
    );
  });

  it('separates two different endpoints', () => {
    expect(endpointFingerprint('https://api.example.com:443/v1')).not.toBe(
      endpointFingerprint('https://api.other.example:443/v1'),
    );
  });

  it('is stable for the same canonical endpoint', () => {
    expect(endpointFingerprint('http://127.0.0.1:11434/v1')).toBe(
      endpointFingerprint('http://127.0.0.1:11434/v1'),
    );
  });
});
