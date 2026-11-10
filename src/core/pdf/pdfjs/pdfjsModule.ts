import type * as pdfjs from 'pdfjs-dist';

/**
 * The exact surface of PDF.js this application uses.
 *
 * The module is injected rather than imported directly so that the same
 * adapter can run against the browser build inside Electron and the legacy
 * build under Node (integration tests). It also makes the dependency's
 * footprint explicit: three exports.
 */
export type PdfjsModule = Pick<typeof pdfjs, 'getDocument' | 'GlobalWorkerOptions' | 'version'>;

export interface PdfjsEngineOptions {
  /**
   * URL of the worker script. When omitted the engine runs PDF.js on the
   * calling thread, which is acceptable for tests but not for the UI.
   */
  readonly workerSrc?: string;
  /** Directory containing the standard 14 font files shipped with PDF.js. */
  readonly standardFontDataUrl?: string;
  /** Directory containing the character maps shipped with PDF.js. */
  readonly cMapUrl?: string;
  /** PDF.js verbosity: 0 errors only, 1 warnings, 5 info. */
  readonly verbosity?: number;
}
