import type { TextSegment } from '../word/types';

/** Why a document could not be opened. Mirrors specification § 20. */
export type PdfOpenFailureKind =
  | 'password-required'
  | 'password-incorrect'
  | 'corrupt'
  | 'missing'
  | 'unsupported'
  /** The reader cancelled the open; not an error, but not a document either. */
  | 'cancelled';

export interface PdfOpenFailure {
  readonly kind: PdfOpenFailureKind;
  /** Message intended for the reader, not a stack trace. */
  readonly message: string;
  /** Underlying error name, retained for logs and bug reports. */
  readonly cause: string;
}

/** The text of one page, already shaped for word identification. */
export interface PdfPageText {
  readonly pageNumber: number;
  readonly segments: readonly TextSegment[];
  /** False when the page carries no extractable text (for example a scan). */
  readonly hasTextLayer: boolean;
}

export interface PdfPageSize {
  readonly width: number;
  readonly height: number;
  /** Page rotation in degrees, as declared by the document. */
  readonly rotation: number;
}

/**
 * An opened document.
 *
 * Deliberately small: the spike only needs page count, page text and the
 * ability to release resources. Rendering is a separate concern owned by the
 * presentation layer, because it requires a canvas.
 */
export interface PdfDocument {
  readonly pageCount: number;
  getPageText(pageNumber: number): Promise<PdfPageText>;
  getPageSize(pageNumber: number): Promise<PdfPageSize>;
  close(): Promise<void>;
}
