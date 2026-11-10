import type { DocumentFailure, DocumentFailureReason } from '@shared/ipc/contracts';

/**
 * One sentence per reason a document could not be opened (M7.2).
 *
 * The main process reports a code; the words are chosen here, in the only
 * layer that knows what a reader is looking at. That split is what makes
 * the boundary in `ARCHITECTURE.md` §5 true rather than aspirational: there
 * is no path to interpolate, no `errno` to quote and no exception message
 * to fall back on, because the renderer is never given any of them.
 *
 * It is the pattern 6.5 established for `APP_INFO_FAILURE_MESSAGES` — a
 * record keyed by a closed union, so adding a reason without writing its
 * sentence does not compile.
 *
 * Each sentence says what happened and, where there is one, what the reader
 * can do. None of them apologises, and none of them mentions a file system.
 */
export const DOCUMENT_FAILURE_MESSAGES: Readonly<Record<DocumentFailureReason, string>> = {
  missing: 'It may have been moved, renamed or deleted.',
  unreadable: 'Check that you have permission to open it, then try again.',
  'not-a-file': 'Choose a PDF file rather than a folder.',
  'too-large': 'This reader opens documents up to 256 MB.',
  unknown: 'Try opening it again, or choose another document.',
};

/** What the opening clause names when there is no file name to use. */
const THAT_DOCUMENT = 'That document';

/**
 * The sentence shown when an *explicitly requested* document fails.
 *
 * The leading clause keeps the wording the recent list has used since
 * Milestone 2 — "<name> could not be opened." — so the one failure path
 * that already had a sanitised sentence does not regress; the second
 * clause is the reason, in the reader's terms.
 *
 * The name is defended again here even though the main process already
 * scrubbed it. This is the last line before the DOM, the cost is one
 * `replace`, and the invariant being protected ("no separator reaches the
 * screen") is worth more than the duplication. The closed reason code,
 * not this, is the architectural boundary.
 */
export const describeDocumentFailure = (failure: DocumentFailure): string => {
  // eslint-disable-next-line no-control-regex -- the same scrub the main process applies
  const name = (failure.name ?? '').replace(/[\\/\u0000-\u001f\u007f]/gu, '').trim();
  const subject = name === '' ? THAT_DOCUMENT : name;

  return `${subject} could not be opened. ${DOCUMENT_FAILURE_MESSAGES[failure.reason]}`;
};
