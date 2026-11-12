import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

import { err, ok, type Result } from '../../result';
import { cancelledOpenFailure, classifyOpenFailure } from '../openFailure';
import { flattenOutline, type PdfOutlineEntry } from '../outline';
import type { OpenedPdf, PdfEngine, PdfSource } from '../pdfEngine';
import { hasExtractableText, itemsToSegments, type PdfTextItem } from '../textSegments';
import type { PdfOpenFailure, PdfPageSize, PdfPageText } from '../types';
import type { PdfjsEngineOptions, PdfjsModule } from './pdfjsModule';

/**
 * PDF.js is given its own copy of the bytes.
 *
 * `getDocument` transfers the underlying buffer to the worker, which detaches
 * it; without a copy the caller's array would be unusable afterwards (for
 * example when retrying with a password).
 */
const copyBytes = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes);

/**
 * Works out which page an outline destination points at.
 *
 * A destination is either a name to look up or an explicit array whose
 * first element says which page: usually a reference to the page object,
 * occasionally the page's index written out as a number.
 */
const pageOfDestination = async (
  document: PDFDocumentProxy,
  destination: unknown,
): Promise<number | null> => {
  const explicit: unknown =
    typeof destination === 'string' ? await document.getDestination(destination) : destination;

  if (!Array.isArray(explicit)) {
    return null;
  }

  const target: unknown = explicit[0];

  if (typeof target === 'number') {
    return Number.isInteger(target) ? target + 1 : null;
  }

  if (typeof target !== 'object' || target === null) {
    return null;
  }

  const { num, gen } = target as { num?: unknown; gen?: unknown };

  if (typeof num !== 'number' || typeof gen !== 'number') {
    return null;
  }

  return (await document.getPageIndex({ num, gen })) + 1;
};

const wrapDocument = (
  loadingTask: PDFDocumentLoadingTask,
  document: PDFDocumentProxy,
  label: string,
): OpenedPdf => ({
  pageCount: document.numPages,
  label,

  async getPageText(pageNumber: number): Promise<PdfPageText> {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const segments = itemsToSegments(content.items as readonly PdfTextItem[]);

    return { pageNumber, segments, hasTextLayer: hasExtractableText(segments) };
  },

  async getPageSize(pageNumber: number): Promise<PdfPageSize> {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });

    return { width: viewport.width, height: viewport.height, rotation: page.rotate };
  },

  async getOutline(): Promise<readonly PdfOutlineEntry[]> {
    try {
      return await flattenOutline(await document.getOutline(), document.numPages, (destination) =>
        pageOfDestination(document, destination),
      );
    } catch {
      // A table of contents is a convenience. One that cannot be read must
      // not stop the document it belongs to from being read.
      return [];
    }
  },

  async getNativePage(pageNumber: number): Promise<unknown> {
    return document.getPage(pageNumber);
  },

  async close(): Promise<void> {
    await loadingTask.destroy();
  },
});

/**
 * Creates the PDF.js implementation of the {@link PdfEngine} port.
 *
 * Everything PDF.js specific about loading a document lives here: worker
 * configuration, parameter choices and failure translation.
 */
export const createPdfjsEngine = (
  pdfjs: PdfjsModule,
  options: PdfjsEngineOptions = {},
): PdfEngine => {
  if (options.workerSrc !== undefined) {
    pdfjs.GlobalWorkerOptions.workerSrc = options.workerSrc;
  }

  return {
    name: 'pdf.js',
    version: pdfjs.version,

    async open(source: PdfSource): Promise<Result<OpenedPdf, PdfOpenFailure>> {
      const signal = source.signal ?? null;
      // A function rather than a direct read: the compiler would otherwise
      // narrow `aborted` to its value at the first check and treat the later
      // ones as dead code, which is exactly what they are not.
      const aborted = (): boolean => signal !== null && signal.aborted;

      if (aborted()) {
        return err(cancelledOpenFailure());
      }

      const loadingTask = pdfjs.getDocument({
        data: copyBytes(source.bytes),
        password: source.password,
        standardFontDataUrl: options.standardFontDataUrl,
        cMapUrl: options.cMapUrl,
        cMapPacked: options.cMapUrl !== undefined,
        verbosity: options.verbosity ?? 0,
        // Local files only: no network fetches for fonts or ranges.
        useWorkerFetch: false,
        disableRange: true,
        disableStream: true,
      });

      // Destroying the loading task is how PDF.js is told to stop; the
      // promise then rejects, and the `aborted` check below turns that
      // rejection into a cancellation rather than a corrupt-file report.
      const abort = (): void => {
        void loadingTask.destroy().catch(() => undefined);
      };

      signal?.addEventListener('abort', abort, { once: true });

      if (source.onProgress !== undefined) {
        const report = source.onProgress;
        loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }): void => {
          report({ loaded, total });
        };
      }

      try {
        const document = await loadingTask.promise;

        if (aborted()) {
          await loadingTask.destroy().catch(() => undefined);
          return err(cancelledOpenFailure());
        }

        return ok(wrapDocument(loadingTask, document, source.label));
      } catch (error) {
        await loadingTask.destroy().catch(() => undefined);

        return err(aborted() ? cancelledOpenFailure() : classifyOpenFailure(error));
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    },
  };
};
