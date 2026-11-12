import type { PdfOutlineEntry } from '@core/pdf/outline';
import type { OpenedPdf } from '@core/pdf/pdfEngine';
import type { PdfOpenFailure, PdfPageSize, PdfPageText } from '@core/pdf/types';
import { err, ok, type Result } from '@core/result';

import { buildChapter, type BuiltChapter } from './chapter';
import { openZip, ZipError, type ZipArchive } from './zip';

/**
 * An EPUB, opened as a book the reader already knows how to show.
 *
 * Each chapter file of the book takes the place a page has in a PDF: it
 * has a number, its text, and a size. That is all the rest of Lexleaf
 * needs for contents, search, word lookup, highlights, bookmarks and
 * remembering the place, so none of those had to learn about EPUB.
 *
 * What is deliberately not done: the book's own styles, fonts and scripts
 * are never used; links are not followed; and a copy-protected book is
 * refused rather than shown as noise.
 */

/** The width a chapter is set to, in CSS pixels at 100 %. */
export const EPUB_PAGE_WIDTH = 680;
/** The least height a chapter is given, so an empty one is still a place. */
export const EPUB_MIN_PAGE_HEIGHT = 240;

const MAX_CHAPTERS = 5000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ALL_IMAGE_BYTES = 96 * 1024 * 1024;
const MAX_OUTLINE_ENTRIES = 5000;

export const EPUB_OPEN_MESSAGE =
  'Unable to open this book.\n\nThe file may be damaged, or not an EPUB that Lexleaf can read.';
export const EPUB_PROTECTED_MESSAGE =
  'This book is copy-protected (DRM), so Lexleaf cannot open it.\n\nBooks without copy protection open normally.';

export interface OpenedEpub extends OpenedPdf {
  readonly kind: 'epub';
  /** The safe tree and text of a chapter. 1-based. */
  getChapter(pageNumber: number): Promise<BuiltChapter>;
}

export const isEpub = (document: OpenedPdf | null): document is OpenedEpub =>
  document !== null && (document as Partial<OpenedEpub>).kind === 'epub';

export interface EpubEnvironment {
  /** The height, in CSS pixels at 100 %, that a chapter takes at the page width. */
  readonly measure: (root: HTMLElement) => Promise<number>;
}

class ProtectedBook extends Error {}

const decoder = new TextDecoder('utf-8');

/** A path inside the book, from a reference in one of its files; `null` if it points outside. */
export const resolveBookPath = (fromFile: string, reference: string): string | null => {
  const [withoutFragment = ''] = reference.split('#');
  const [raw = ''] = withoutFragment.split('?');

  // Anything with a scheme, or starting with two slashes, is somewhere else.
  if (raw.length === 0 || /^[a-z][a-z0-9+.-]*:/iu.test(raw) || raw.startsWith('//')) {
    return null;
  }

  let decoded: string;

  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }

  const base = decoded.startsWith('/') ? [] : fromFile.split('/').slice(0, -1);
  const parts: string[] = [...base];

  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }

    if (part === '..') {
      if (parts.length === 0) {
        return null;
      }

      parts.pop();
      continue;
    }

    parts.push(part);
  }

  return parts.join('/');
};

const parseXml = (text: string): Document | null => {
  const parsed = new DOMParser().parseFromString(text, 'application/xml');

  return parsed.querySelector('parsererror') === null ? parsed : null;
};

/** A chapter is XHTML; one that is not well formed is read leniently instead. */
const parseChapter = (text: string): Document =>
  parseXml(text) ?? new DOMParser().parseFromString(text, 'text/html');

const elementsNamed = (parent: Document | Element, name: string): Element[] =>
  [...parent.getElementsByTagName('*')].filter((element) => element.localName === name);

const childrenNamed = (parent: Element, name: string): Element[] =>
  [...parent.children].filter((element) => element.localName === name);

const imageType = (bytes: Uint8Array): string | null => {
  const starts = (...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte);

  if (starts(0x89, 0x50, 0x4e, 0x47)) {
    return 'image/png';
  }

  if (starts(0xff, 0xd8, 0xff)) {
    return 'image/jpeg';
  }

  if (starts(0x47, 0x49, 0x46, 0x38)) {
    return 'image/gif';
  }

  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) {
    return 'image/webp';
  }

  // Anything else — SVG included, which is a document and not a picture — is left out.
  return null;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';

  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }

  return btoa(binary);
};

const FONT_OBFUSCATION = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
]);

const refuseProtected = async (zip: ZipArchive): Promise<void> => {
  if (zip.has('META-INF/rights.xml')) {
    throw new ProtectedBook();
  }

  if (!zip.has('META-INF/encryption.xml')) {
    return;
  }

  const parsed = parseXml(decoder.decode(await zip.read('META-INF/encryption.xml')));

  // Obscured fonts are not copy protection, and the book's fonts are not used anyway.
  const methods =
    parsed === null
      ? null
      : elementsNamed(parsed, 'EncryptionMethod').map((element) =>
          element.getAttribute('Algorithm'),
        );

  if (
    methods === null ||
    methods.some((method) => method === null || !FONT_OBFUSCATION.has(method))
  ) {
    throw new ProtectedBook();
  }
};

interface Package {
  readonly spine: readonly string[];
  readonly navPath: string | null;
  readonly ncxPath: string | null;
}

const readPackage = async (zip: ZipArchive): Promise<Package> => {
  const container = parseXml(decoder.decode(await zip.read('META-INF/container.xml')));
  const opfPath =
    container === null ? null : elementsNamed(container, 'rootfile')[0]?.getAttribute('full-path');

  if (opfPath === null || opfPath === undefined) {
    throw new Error('The book does not say where its package file is.');
  }

  const opf = parseXml(decoder.decode(await zip.read(opfPath)));

  if (opf === null) {
    throw new Error('The package file is not well formed.');
  }

  const items = new Map<string, { path: string; type: string; properties: string }>();

  for (const item of elementsNamed(opf, 'item')) {
    const id = item.getAttribute('id');
    const path = resolveBookPath(opfPath, item.getAttribute('href') ?? '');

    if (id !== null && path !== null) {
      items.set(id, {
        path,
        type: item.getAttribute('media-type') ?? '',
        properties: item.getAttribute('properties') ?? '',
      });
    }
  }

  const spineElement = elementsNamed(opf, 'spine')[0];
  const spine = (spineElement === undefined ? [] : childrenNamed(spineElement, 'itemref'))
    .map((reference) => items.get(reference.getAttribute('idref') ?? ''))
    .filter(
      (item): item is { path: string; type: string; properties: string } =>
        item !== undefined && zip.has(item.path),
    )
    .map((item) => item.path);

  if (spine.length === 0 || spine.length > MAX_CHAPTERS) {
    throw new Error('The book has no chapters, or too many.');
  }

  const nav = [...items.values()].find((item) => item.properties.split(/\s+/u).includes('nav'));
  const ncx =
    items.get(spineElement?.getAttribute('toc') ?? '') ??
    [...items.values()].find((item) => item.type === 'application/x-dtbncx+xml');

  return { spine, navPath: nav?.path ?? null, ncxPath: ncx?.path ?? null };
};

const readOutline = async (zip: ZipArchive, pack: Package): Promise<PdfOutlineEntry[]> => {
  const entries: PdfOutlineEntry[] = [];
  const pageOf = (file: string, reference: string | null): number | null => {
    const path = reference === null ? null : resolveBookPath(file, reference);
    const index = path === null ? -1 : pack.spine.indexOf(path);

    return index < 0 ? null : index + 1;
  };
  const add = (title: string, pageNumber: number | null, depth: number): void => {
    const clean = title.replace(/\s+/gu, ' ').trim().slice(0, 300);

    if (clean.length > 0 && entries.length < MAX_OUTLINE_ENTRIES) {
      entries.push({ title: clean, pageNumber, depth: Math.min(depth, 8) });
    }
  };

  if (pack.navPath !== null && zip.has(pack.navPath)) {
    const navPath = pack.navPath;
    const parsed = parseChapter(decoder.decode(await zip.read(navPath)));
    const navs = elementsNamed(parsed, 'nav');
    const toc = navs.find((nav) => nav.getAttribute('epub:type') === 'toc') ?? navs[0];

    const walk = (list: Element, depth: number): void => {
      for (const item of childrenNamed(list, 'li')) {
        const label = childrenNamed(item, 'a')[0] ?? childrenNamed(item, 'span')[0];

        if (label !== undefined) {
          add(label.textContent ?? '', pageOf(navPath, label.getAttribute('href')), depth);
        }

        for (const nested of childrenNamed(item, 'ol')) {
          walk(nested, depth + 1);
        }
      }
    };

    for (const list of toc === undefined ? [] : childrenNamed(toc, 'ol')) {
      walk(list, 0);
    }
  }

  if (entries.length === 0 && pack.ncxPath !== null && zip.has(pack.ncxPath)) {
    const ncxPath = pack.ncxPath;
    const parsed = parseXml(decoder.decode(await zip.read(ncxPath)));

    const walk = (parent: Element, depth: number): void => {
      for (const point of childrenNamed(parent, 'navPoint')) {
        const label = childrenNamed(point, 'navLabel')[0]?.textContent ?? '';
        const target = childrenNamed(point, 'content')[0]?.getAttribute('src') ?? null;

        add(label, pageOf(ncxPath, target), depth);
        walk(point, depth + 1);
      }
    };

    const map = parsed === null ? undefined : elementsNamed(parsed, 'navMap')[0];

    if (map !== undefined) {
      walk(map, 0);
    }
  }

  return entries;
};

export const openEpub = async (
  bytes: Uint8Array,
  label: string,
  environment: EpubEnvironment,
): Promise<Result<OpenedEpub, PdfOpenFailure>> => {
  try {
    const zip = openZip(bytes);

    await refuseProtected(zip);

    const pack = await readPackage(zip);
    const outline = await readOutline(zip, pack).catch((): PdfOutlineEntry[] => []);

    const images = new Map<string, Promise<string | null>>();
    let imageBytes = 0;

    const image = (path: string): Promise<string | null> => {
      const known = images.get(path);

      if (known !== undefined) {
        return known;
      }

      const loading = (async (): Promise<string | null> => {
        if (!zip.has(path)) {
          return null;
        }

        const data = await zip.read(path);
        const type = imageType(data);

        if (
          type === null ||
          data.byteLength > MAX_IMAGE_BYTES ||
          imageBytes + data.byteLength > MAX_ALL_IMAGE_BYTES
        ) {
          return null;
        }

        imageBytes += data.byteLength;

        return `data:${type};base64,${toBase64(data)}`;
      })().catch(() => null);

      images.set(path, loading);

      return loading;
    };

    const chapters = new Map<number, Promise<BuiltChapter>>();
    const sizes = new Map<number, Promise<PdfPageSize>>();

    const chapterPath = (pageNumber: number): string => {
      const path = pack.spine[pageNumber - 1];

      if (path === undefined) {
        throw new RangeError(`The book has no chapter ${String(pageNumber)}.`);
      }

      return path;
    };

    const getChapter = (pageNumber: number): Promise<BuiltChapter> => {
      const known = chapters.get(pageNumber);

      if (known !== undefined) {
        return known;
      }

      const building = (async (): Promise<BuiltChapter> => {
        const path = chapterPath(pageNumber);
        const source = parseChapter(decoder.decode(await zip.read(path)));

        return buildChapter(source, document, {
          image: (href) => {
            const target = resolveBookPath(path, href);

            return target === null ? Promise.resolve(null) : image(target);
          },
        });
      })();

      chapters.set(pageNumber, building);

      return building;
    };

    return ok({
      kind: 'epub',
      pageCount: pack.spine.length,
      label,
      getChapter,

      async getPageText(pageNumber: number): Promise<PdfPageText> {
        const { segments } = await getChapter(pageNumber);

        return { pageNumber, segments, hasTextLayer: true };
      },

      getPageSize(pageNumber: number): Promise<PdfPageSize> {
        const known = sizes.get(pageNumber);

        if (known !== undefined) {
          return known;
        }

        const measuring = (async (): Promise<PdfPageSize> => {
          // A chapter that cannot be read still has a place; it says so when shown.
          const height = await getChapter(pageNumber)
            .then((chapter) => environment.measure(chapter.root))
            .catch(() => 0);

          return {
            width: EPUB_PAGE_WIDTH,
            height: Math.max(EPUB_MIN_PAGE_HEIGHT, Math.ceil(height)),
            rotation: 0,
          };
        })();

        sizes.set(pageNumber, measuring);

        return measuring;
      },

      getOutline: () => Promise.resolve(outline),

      getNativePage: () => Promise.reject(new Error('An EPUB chapter is not a PDF page.')),

      close: (): Promise<void> => {
        chapters.clear();
        sizes.clear();
        images.clear();

        return Promise.resolve();
      },
    });
  } catch (error) {
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

    if (error instanceof ProtectedBook) {
      return err({ kind: 'unsupported', message: EPUB_PROTECTED_MESSAGE, cause: 'copy-protected' });
    }

    return err({
      kind: error instanceof ZipError ? 'corrupt' : 'unsupported',
      message: EPUB_OPEN_MESSAGE,
      cause,
    });
  }
};
