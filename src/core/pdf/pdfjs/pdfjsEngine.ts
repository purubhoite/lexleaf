import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

import { err, ok, type Result } from '../../result';
import { cancelledOpenFailure, classifyOpenFailure } from '../openFailure';
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
