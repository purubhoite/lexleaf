import { describe, expect, it } from 'vitest';

import { parseDocumentArgument } from './initialDocument';

describe('parseDocumentArgument', () => {
  it('reads the path from the switch', () => {
    expect(parseDocumentArgument(['electron', '.', '--open-document=/books/harbour.pdf'])).toBe(
      '/books/harbour.pdf',
    );
  });

  it('accepts a Windows path', () => {
    expect(parseDocumentArgument(['--open-document=C:\\Users\\reader\\harbour.pdf'])).toBe(
      'C:\\Users\\reader\\harbour.pdf',
    );
  });

  it('ignores positional arguments', () => {
    // Electron and Chromium add their own; a stray argument must never cause
    // the application to read a file.
    expect(parseDocumentArgument(['electron', '.', '/books/harbour.pdf'])).toBeNull();
  });

  it('ignores an empty value', () => {
    expect(parseDocumentArgument(['--open-document=', '--open-document=   '])).toBeNull();
  });

  it('returns null when the switch is absent', () => {
    expect(parseDocumentArgument(['electron', '.', '--enable-logging'])).toBeNull();
  });

  it('uses the first occurrence', () => {
    expect(parseDocumentArgument(['--open-document=a.pdf', '--open-document=b.pdf'])).toBe('a.pdf');
  });
});
