import { describe, expect, it } from 'vitest';

import { deflate, makeZip } from './testZip';
import { looksLikeZip, openZip, ZipError } from './zip';

const text = async (promise: Promise<Uint8Array>): Promise<string> =>
  new TextDecoder().decode(await promise);

describe('reading a zip archive', () => {
  it('lists the files and reads them, stored or deflated', async () => {
    const chapter = new TextEncoder().encode('hello '.repeat(500));
    const zip = openZip(
      makeZip([
        { name: 'mimetype', data: 'application/epub+zip' },
        { name: 'OEBPS/ch1.xhtml', data: chapter, deflated: await deflate(chapter) },
      ]),
    );

    expect(zip.names).toStrictEqual(['mimetype', 'OEBPS/ch1.xhtml']);
    expect(zip.has('mimetype')).toBe(true);
    expect(zip.has('nope')).toBe(false);
    await expect(text(zip.read('mimetype'))).resolves.toBe('application/epub+zip');
    await expect(text(zip.read('OEBPS/ch1.xhtml'))).resolves.toBe('hello '.repeat(500));
  });

  it('tells a zip from a PDF by its first bytes', () => {
    expect(looksLikeZip(makeZip([{ name: 'a', data: 'a' }]))).toBe(true);
    expect(looksLikeZip(new TextEncoder().encode('%PDF-1.7'))).toBe(false);
    expect(looksLikeZip(new Uint8Array())).toBe(false);
  });

  it('refuses bytes that are not an archive', () => {
    expect(() =>
      openZip(new TextEncoder().encode('PK\u0003\u0004 not really a zip at all')),
    ).toThrow(ZipError);
  });

  it('refuses a file that is not there', async () => {
    const zip = openZip(makeZip([{ name: 'a', data: 'a' }]));

    await expect(zip.read('b')).rejects.toBeInstanceOf(ZipError);
  });

  it('refuses a password-protected file', async () => {
    const zip = openZip(makeZip([{ name: 'a', data: 'a', encrypted: true }]));

    await expect(zip.read('a')).rejects.toThrow(/password/u);
  });

  it('stops a small file that unpacks to an enormous one', async () => {
    // 2 MB of zeros deflates to a couple of kilobytes.
    const zeros = new Uint8Array(2 * 1024 * 1024);
    const bomb = makeZip([{ name: 'bomb', data: zeros, deflated: await deflate(zeros) }]);

    expect(bomb.length).toBeLessThan(10_000);

    const zip = openZip(bomb, { maxEntries: 10, maxEntryBytes: 100_000, maxTotalBytes: 1e9 });

    await expect(zip.read('bomb')).rejects.toThrow(/more than is allowed/u);
  });

  it('stops many files that together unpack to too much', async () => {
    const zip = openZip(
      makeZip([
        { name: 'a', data: new Uint8Array(60_000) },
        { name: 'b', data: new Uint8Array(60_000) },
      ]),
      { maxEntries: 10, maxEntryBytes: 100_000, maxTotalBytes: 100_000 },
    );

    await zip.read('a');
    await expect(zip.read('b')).rejects.toBeInstanceOf(ZipError);
  });

  it('refuses an archive that lists too many files', () => {
    const files = Array.from({ length: 5 }, (_, index) => ({
      name: `f${String(index)}`,
      data: 'x',
    }));

    expect(() =>
      openZip(makeZip(files), { maxEntries: 4, maxEntryBytes: 1e6, maxTotalBytes: 1e6 }),
    ).toThrow(/more files/u);
  });

  it('refuses an archive whose file runs past its end', async () => {
    const whole = makeZip([{ name: 'a', data: 'some text that is stored' }]);
    const view = new DataView(whole.buffer);
    const directory = view.getUint32(whole.length - 22 + 16, true);

    // The directory claims the file is far longer than the archive.
    view.setUint32(directory + 20, 1_000_000, true);

    await expect(openZip(whole).read('a')).rejects.toThrow(/cut short/u);
  });
});
