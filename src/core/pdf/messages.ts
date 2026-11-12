/**
 * Reader-facing copy mandated by the product specification (section 20).
 *
 * The strings are reproduced exactly, including line breaks, and kept in one
 * place so that the wording cannot drift between the engine and the UI.
 */

/** Shown when a document cannot be opened at all. */
export const UNABLE_TO_OPEN_MESSAGE =
  'Unable to open this PDF.\n\nThe file may be corrupted, encrypted, or unsupported.';

/**
 * Shown once for a document that has no text anywhere it was looked: in
 * practice a scan, where every page is a photograph of a page.
 *
 * The specification's two lines said only that lookup was unavailable. A
 * reader who double-clicks a word and gets nothing needs three more things:
 * why, that the book can still be read, and what would make lookup work.
 * The first sentence keeps the specification's wording.
 */
export const NO_TEXT_LAYER_MESSAGE =
  'This PDF does not contain selectable text, so words in it cannot be looked up or searched.\n' +
  'It is probably a scan: each page is a picture. You can still read it here.\n' +
  'To look up words, add a text layer to the file with an OCR tool such as OCRmyPDF, then open the new file.';

/**
 * Shown on a single page without text in a document that otherwise has
 * some: a cover, a plate, a scanned insert.
 */
export const PAGE_WITHOUT_TEXT_MESSAGE =
  'This page does not contain selectable text, so words on it cannot be looked up. It is probably a picture of a page.';

/**
 * Password handling is not among the specification's examples; the wording
 * follows the same shape so that a protected document is distinguishable from
 * a damaged one instead of being reported as unopenable.
 */
export const PASSWORD_REQUIRED_MESSAGE =
  'This PDF is password protected.\n\nEnter the password to open it.';

export const PASSWORD_INCORRECT_MESSAGE =
  'That password did not open this PDF.\n\nCheck the password and try again.';

/** Shown only briefly: the reader asked for the load to stop. */
export const OPEN_CANCELLED_MESSAGE = 'Opening this PDF was cancelled.';

/**
 * Shown when one page of an opened document cannot be drawn.
 *
 * Also not among the specification's examples — the specification speaks of
 * documents, not of single pages — so it follows the same shape: it names
 * what failed and stops there. Whatever the engine said about the failure is
 * an implementation detail. It can quote a file path, a decoder internal or
 * an exception, and no reader can act on any of it, so none of it is
 * rendered; only the page number varies.
 */
export const pageUnavailableMessage = (pageNumber: number): string =>
  `Page ${String(pageNumber)} could not be displayed.`;
