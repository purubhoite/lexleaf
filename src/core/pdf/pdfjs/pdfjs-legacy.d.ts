/**
 * PDF.js ships type declarations only for its default entry point.
 *
 * The legacy build is the one that runs under plain Node (used by the
 * integration tests); it exposes the same API, so the declarations are
 * re-exported rather than duplicated.
 */
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist';
}
