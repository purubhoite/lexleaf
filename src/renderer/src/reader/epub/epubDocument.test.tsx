/** @vitest-environment jsdom */
import { joinSegments } from '@core/word/identifyWord';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPageRegistry } from '../interaction/pageRegistry';
import { rangeForSpan } from '../pdf/textRanges';

import { EpubPageSurface } from './EpubPageSurface';
import {
  EPUB_MIN_PAGE_HEIGHT,
  EPUB_OPEN_MESSAGE,
  EPUB_PAGE_WIDTH,
  EPUB_PROTECTED_MESSAGE,
  isEpub,
  openEpub,
  resolveBookPath,
  type OpenedEpub,
} from './epubDocument';
import { makeZip, type TestFile } from './testZip';

afterEach(() => {
  cleanup();
});

const CONTAINER = `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

const chapter = (body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${body}</body></html>`;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const OPF = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="text/ch%202.xhtml" media-type="application/xhtml+xml"/>
<item id="gone" href="text/missing.xhtml" media-type="application/xhtml+xml"/>
<item id="img" href="images/cat.png" media-type="image/png"/>
</manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="gone"/><itemref idref="c2"/></spine></package>`;

const NAV = chapter(
  `<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><a href="text/ch1.xhtml">Chapter  One</a><ol><li><a href="text/ch1.xhtml#s2">A section</a></li></ol></li><li><a href="text/ch%202.xhtml">Chapter Two</a></li><li><a href="https://x.example/">Elsewhere</a></li></ol></nav>`,
);

const NCX = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>From the NCX</text></navLabel><content src="text/ch1.xhtml"/><navPoint><navLabel><text>Nested</text></navLabel><content src="text/ch%202.xhtml#x"/></navPoint></navPoint></navMap></ncx>`;

const book = (overrides: Record<string, string | Uint8Array | null> = {}): Uint8Array => {
  const files: Record<string, string | Uint8Array | null> = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': OPF,
    'OEBPS/nav.xhtml': NAV,
    'OEBPS/toc.ncx': NCX,
    'OEBPS/text/ch1.xhtml': chapter(
      '<h1>One</h1><p>The quick brown fox.</p><p><img src="../images/cat.png" alt="cat"/><img src="../../../../etc/passwd"/><img src="http://x.example/a.png"/></p><script>window.hacked = true;</script>',
    ),
    'OEBPS/text/ch 2.xhtml': chapter('<h1>Two</h1><p>Jumps over.</p>'),
    'OEBPS/images/cat.png': PNG,
    ...overrides,
  };

  return makeZip(
    Object.entries(files)
      .filter((entry): entry is [string, string | Uint8Array] => entry[1] !== null)
      .map(([name, data]): TestFile => ({ name, data })),
  );
};

const open = async (bytes: Uint8Array, measure = vi.fn(() => Promise.resolve(1000))) => {
  const result = await openEpub(bytes, 'book.epub', { measure });

  return { result, measure };
};

const opened = async (bytes: Uint8Array = book()): Promise<OpenedEpub> => {
  const { result } = await open(bytes);

  if (!result.ok) {
    throw new Error(result.error.cause);
  }

  return result.value;
};

describe('paths inside a book', () => {
  it('resolves against the file that makes the reference', () => {
    expect(resolveBookPath('OEBPS/text/ch1.xhtml', '../images/a.png')).toBe('OEBPS/images/a.png');
    expect(resolveBookPath('OEBPS/content.opf', 'text/ch%202.xhtml#frag')).toBe(
      'OEBPS/text/ch 2.xhtml',
    );
    expect(resolveBookPath('a/b.xhtml', './c.xhtml?x=1')).toBe('a/c.xhtml');
  });

  it('refuses anything that points outside the book', () => {
    expect(resolveBookPath('OEBPS/ch.xhtml', '../../secret')).toBeNull();
    expect(resolveBookPath('OEBPS/ch.xhtml', 'https://x.example/a.png')).toBeNull();
    expect(resolveBookPath('OEBPS/ch.xhtml', 'file:///etc/passwd')).toBeNull();
    expect(resolveBookPath('OEBPS/ch.xhtml', '//x.example/a.png')).toBeNull();
    expect(resolveBookPath('OEBPS/ch.xhtml', 'javascript:alert(1)')).toBeNull();
    expect(resolveBookPath('OEBPS/ch.xhtml', '#only-a-fragment')).toBeNull();
  });
});

describe('opening an EPUB', () => {
  it('has one page for each chapter the book really contains, in reading order', async () => {
    const epub = await opened();

    expect(isEpub(epub)).toBe(true);
    expect(epub.pageCount).toBe(2);
    expect(joinSegments((await epub.getPageText(1)).segments).text).toContain(
      'The quick brown fox.',
    );
    expect(joinSegments((await epub.getPageText(2)).segments).text).toContain('Jumps over.');
  });

  it('reads the contents from the navigation file, with depth and page', async () => {
    const epub = await opened();

    expect(await epub.getOutline()).toStrictEqual([
      { title: 'Chapter One', pageNumber: 1, depth: 0 },
      { title: 'A section', pageNumber: 1, depth: 1 },
      { title: 'Chapter Two', pageNumber: 2, depth: 0 },
      { title: 'Elsewhere', pageNumber: null, depth: 0 },
    ]);
  });

  it('falls back to the older contents file', async () => {
    const epub = await opened(book({ 'OEBPS/nav.xhtml': null }));

    expect(await epub.getOutline()).toStrictEqual([
      { title: 'From the NCX', pageNumber: 1, depth: 0 },
      { title: 'Nested', pageNumber: 2, depth: 1 },
    ]);
  });

  it('opens a book with no contents at all', async () => {
    const epub = await opened(book({ 'OEBPS/nav.xhtml': null, 'OEBPS/toc.ncx': null }));

    expect(await epub.getOutline()).toStrictEqual([]);
  });

  it('shows pictures from inside the book only, and runs nothing', async () => {
    const epub = await opened();
    const { root } = await epub.getChapter(1);
    const pictures = [...root.querySelectorAll('img')];

    expect(pictures).toHaveLength(1);
    expect(pictures[0]?.getAttribute('src')).toMatch(/^data:image\/png;base64,/u);
    expect(root.querySelector('script')).toBeNull();
    expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it('leaves out a picture that is not really a picture', async () => {
    const epub = await opened(
      book({
        'OEBPS/images/cat.png': '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>',
      }),
    );

    expect((await epub.getChapter(1)).root.querySelector('img')).toBeNull();
  });

  it('gives each chapter the standard width and its measured height, measured once', async () => {
    const { result, measure } = await open(book());

    if (!result.ok) {
      throw new Error(result.error.cause);
    }

    expect(await result.value.getPageSize(1)).toStrictEqual({
      width: EPUB_PAGE_WIDTH,
      height: 1000,
      rotation: 0,
    });
    await result.value.getPageSize(1);

    expect(measure).toHaveBeenCalledOnce();
  });

  it('gives an empty chapter a place all the same', async () => {
    const { result } = await open(
      book(),
      vi.fn(() => Promise.resolve(0)),
    );

    if (!result.ok) {
      throw new Error(result.error.cause);
    }

    expect((await result.value.getPageSize(2)).height).toBe(EPUB_MIN_PAGE_HEIGHT);
  });

  it('reads a chapter that is not well formed, leniently', async () => {
    const epub = await opened(
      book({
        'OEBPS/text/ch 2.xhtml': '<html><body><p>Unclosed &nbsp; paragraph<p>Next</body></html>',
      }),
    );

    expect((await epub.getChapter(2)).root.textContent).toContain('Next');
  });

  it('has no PDF page to hand over', async () => {
    const epub = await opened();

    await expect(epub.getNativePage(1)).rejects.toThrow();
  });
});

describe('books that cannot be opened', () => {
  it('refuses a copy-protected book and says why', async () => {
    const { result } = await open(
      book({
        'META-INF/encryption.xml': `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>`,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'unsupported', message: EPUB_PROTECTED_MESSAGE },
    });
  });

  it('refuses a book with a rights file', async () => {
    const { result } = await open(book({ 'META-INF/rights.xml': '<rights/>' }));

    expect(result).toMatchObject({ ok: false, error: { message: EPUB_PROTECTED_MESSAGE } });
  });

  it('opens a book whose only "encryption" is obscured fonts', async () => {
    const { result } = await open(
      book({
        'META-INF/encryption.xml': `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/></EncryptedData></encryption>`,
      }),
    );

    expect(result.ok).toBe(true);
  });

  it.each([
    ['a zip that is not a book', makeZip([{ name: 'readme.txt', data: 'hi' }])],
    ['a book with no package file', book({ 'OEBPS/content.opf': null })],
    ['a book whose package file is broken', book({ 'OEBPS/content.opf': '<package><unclosed>' })],
    [
      'a book with no chapters',
      book({ 'OEBPS/text/ch1.xhtml': null, 'OEBPS/text/ch 2.xhtml': null }),
    ],
    [
      'bytes that only begin like a zip',
      new TextEncoder().encode('PK\u0003\u0004 and then nothing useful'),
    ],
  ])('fails plainly for %s', async (_name, bytes) => {
    const { result } = await open(bytes);

    expect(result).toMatchObject({ ok: false, error: { message: EPUB_OPEN_MESSAGE } });
  });
});

describe('a chapter on screen', () => {
  it('shows the chapter and offers its text for lookup, search and highlights', async () => {
    const epub = await opened();
    const registry = createPageRegistry();
    const onTextPresence = vi.fn();

    const { container } = render(
      <EpubPageSurface
        document={epub}
        documentId="doc"
        pageNumber={1}
        scale={1.5}
        top={0}
        width={EPUB_PAGE_WIDTH * 1.5}
        height={1500}
        registry={registry}
        spans={[]}
        onTextPresence={onTextPresence}
      />,
    );

    await waitFor(() => {
      expect(registry.get(1)).not.toBeNull();
    });

    const page = registry.get(1);

    if (page === null) {
      throw new Error('not registered');
    }

    expect(container.querySelector('h1')?.textContent).toBe('One');
    expect(onTextPresence).toHaveBeenCalledWith(1, true);

    // A place in the chapter's text maps onto the words on screen.
    const { text } = joinSegments(page.layer.segments);
    const start = text.indexOf('quick');
    const range = rangeForSpan(document, page.layer, start, start + 5);

    expect(range?.toString()).toBe('quick');
    // And a node on screen maps back to the chapter it belongs to.
    expect(registry.pageOfNode(range?.startContainer ?? null)).toBe(page);
  });

  it('leaves the registry when it goes away', async () => {
    const epub = await opened();
    const registry = createPageRegistry();
    const { unmount } = render(
      <EpubPageSurface
        document={epub}
        documentId="doc"
        pageNumber={2}
        scale={1}
        top={0}
        width={EPUB_PAGE_WIDTH}
        height={1000}
        registry={registry}
        spans={[]}
        onTextPresence={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(registry.get(2)).not.toBeNull();
    });
    unmount();

    expect(registry.get(2)).toBeNull();
  });
});
