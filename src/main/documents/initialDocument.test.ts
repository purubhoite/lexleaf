import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseDocumentArgument, parseDroppedDocumentPath } from './initialDocument';

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

  it('accepts a PDF named as a positional argument, as a file manager passes it', () => {
    expect(parseDocumentArgument(['/opt/Lexleaf/lexleaf', '/books/harbour.pdf'])).toBe(
      '/books/harbour.pdf',
    );
    expect(
      parseDocumentArgument(['C:\\Programs\\Lexleaf\\Lexleaf.exe', 'C:\\Books\\Harbour.PDF']),
    ).toBe('C:\\Books\\Harbour.PDF');
  });

  // These two go through the operating system's own path rules, so the
  // expected value is built with them rather than written out.
  it('accepts a file address, decoded', () => {
    const path = resolve('books', 'the harbour.pdf');
    const address = pathToFileURL(path).href;

    expect(address).toContain('the%20harbour.pdf');
    expect(parseDocumentArgument(['lexleaf', address])).toBe(path);
  });

  it('resolves a relative name against the directory it was typed in', () => {
    const directory = resolve('books');

    expect(parseDocumentArgument(['lexleaf', 'harbour.pdf'], directory)).toBe(
      join(directory, 'harbour.pdf'),
    );
    expect(parseDocumentArgument(['lexleaf', 'harbour.pdf'])).toBeNull();
  });

  it('ignores every other positional argument', () => {
    // Electron and Chromium add their own; a stray argument must never cause
    // the application to read a file.
    for (const stray of [
      '.',
      '/books/harbour.txt',
      '/books/harbour.pdf.exe',
      'https://example.com/harbour.pdf',
      'file:///books/harbour.txt',
      'file://%zz/harbour.pdf',
      ' /books/harbour.pdf',
      '--some-switch=/books/harbour.pdf',
    ]) {
      expect(parseDocumentArgument(['electron', stray], '/books')).toBeNull();
    }
  });

  it('never takes the executable itself for a document', () => {
    expect(parseDocumentArgument(['/opt/odd/reader.pdf'])).toBeNull();
  });

  it('prefers the switch to a positional argument', () => {
    expect(parseDocumentArgument(['lexleaf', '/a.pdf', '--open-document=/b.pdf'])).toBe('/b.pdf');
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

describe('parseDroppedDocumentPath', () => {
  it('accepts an absolute path to a PDF', () => {
    expect(parseDroppedDocumentPath('/books/harbour.pdf')).toBe('/books/harbour.pdf');
    expect(parseDroppedDocumentPath('C:\\Books\\Harbour.PDF')).toBe('C:\\Books\\Harbour.PDF');
  });

  it('refuses everything else', () => {
    for (const raw of [
      null,
      undefined,
      42,
      {},
      '',
      'harbour.pdf',
      '../harbour.pdf',
      '/books/harbour.txt',
      '/etc/passwd',
      '/books/harbour.pdf\0.txt',
      `/${'a'.repeat(5000)}.pdf`,
    ]) {
      expect(parseDroppedDocumentPath(raw)).toBeNull();
    }
  });
});
