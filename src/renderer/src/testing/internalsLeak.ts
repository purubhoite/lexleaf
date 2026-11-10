/**
 * The patterns a reader must never be shown when something fails.
 *
 * Test support, not application code: it sits beside the bridge stubs in
 * `src/renderer/src/testing` and is imported only by tests, so it is never
 * part of a bundle.
 *
 * 6.5 applied this battery to the library's failure sentences. The 6.5
 * acceptance audit (C-3) found two surfaces it had not been pointed at —
 * the shell's "application details are unavailable" line, which printed
 * the rejected IPC call's own message, and the document-open failure
 * screen, which printed the PDF engine's `name: message` underneath the
 * specification copy. Both are sanitised now, and both are checked here,
 * from one list, so a third surface cannot be checked against a weaker
 * one.
 *
 * What each pattern is for:
 *
 * - a POSIX or Windows path: where the reader's files live is not news a
 *   failure message should carry, and `MissingPDFException` quotes one;
 * - `Error`, a stack frame, an errno or a SQLite code: engine wording;
 * - an http(s) URL: a provider endpoint (M5 forbids these in the renderer
 *   entirely, and a message is still a way out);
 * - a bare `undefined`, `null` or `[object …]`: a template that was handed
 *   something it did not expect;
 * - a JSON fragment: a payload that escaped into prose.
 */
export const INTERNALS: readonly RegExp[] = [
  /\/(?:home|users|var|tmp)\//i,
  /[A-Z]:\\/,
  /\bError\b/,
  /\bat .+:\d+:\d+/,
  /\bEACCES|ENOENT|SQLITE_/,
  /\bhttps?:\/\//i,
  /\bundefined\b|\bnull\b|\[object /,
  /\{.*"\w+":/,
];

/** The patterns a piece of user-facing text matches; empty is the pass. */
export const leaks = (text: string): RegExp[] => INTERNALS.filter((pattern) => pattern.test(text));
