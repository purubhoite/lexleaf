import type { Result } from '../result';
import type { PdfOpenFailure, PdfPageSize, PdfPageText } from './types';

/** How far a document has loaded, as reported by the engine. */
export interface PdfLoadProgress {
  readonly loaded: number;
  /** 0 when the engine does not know the total yet. */
  readonly total: number;
}

/** Bytes of a document, together with an optional password. */
export interface PdfSource {
  readonly bytes: Uint8Array;
  readonly password?: string;
  /** Used only in messages and logs. */
  readonly label: string;
  /**
   * Aborts the open. A large document can take long enough that the reader
   * changes their mind, and an abandoned load that keeps running would still
   * deliver its result into a reader that has moved on.
   */
  readonly signal?: AbortSignal;
  /** Called while the document loads, for progress the reader can see. */
  readonly onProgress?: (progress: PdfLoadProgress) => void;
}

/**
 * A document that has been opened successfully.
 *
 * `getNativePage` is the single, deliberate escape hatch: rendering pixels
 * needs a canvas, which cannot exist in this layer. Only the presentation
 * layer's PDF module may call it (see docs/ARCHITECTURE.md); React components
 * must not.
 */
export interface OpenedPdf {
  readonly pageCount: number;
  readonly label: string;
  getPageText(pageNumber: number): Promise<PdfPageText>;
  getPageSize(pageNumber: number): Promise<PdfPageSize>;
  getNativePage(pageNumber: number): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * The port the application depends on instead of PDF.js directly (ADR-003).
 *
 * Swapping the engine means providing another implementation of this
 * interface; nothing above it refers to PDF.js types.
 */
export interface PdfEngine {
  readonly name: string;
  readonly version: string;
  open(source: PdfSource): Promise<Result<OpenedPdf, PdfOpenFailure>>;
}
