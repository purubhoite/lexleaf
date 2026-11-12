import { posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The document named on a command line.
 *
 * Two forms are honoured:
 *
 * - the explicit `--open-document=<path>` switch, and
 * - a positional argument that names a PDF: a path or a `file:` address
 *   ending in `.pdf`. This is what a file manager passes when a reader
 *   double-clicks a PDF or chooses "Open with Lexleaf" — neither Windows
 *   nor a Linux desktop entry can be made to pass the switch instead.
 *
 * Every other positional argument is ignored. Electron and Chromium add
 * their own, and a stray argument must never cause the application to read
 * a file; none of theirs is a path ending in `.pdf`. Naming a file here
 * only selects it: whether it is read is decided by the open pipeline,
 * which checks that it really is a PDF.
 */
const SWITCH = '--open-document=';

const PDF_NAME = /\.(?:pdf|epub)$/iu;

const isAbsolutePath = (path: string): boolean => posix.isAbsolute(path) || win32.isAbsolute(path);

const positionalDocument = (argument: string, workingDirectory: string | null): string | null => {
  if (argument.startsWith('-') || argument.trim() !== argument) {
    return null;
  }

  if (/^file:/iu.test(argument)) {
    try {
      const path = fileURLToPath(argument);

      return PDF_NAME.test(path) ? path : null;
    } catch {
      return null;
    }
  }

  // Any other scheme is an address, not a file.
  if (/^[a-z][a-z0-9+.-]+:\/\//iu.test(argument) || !PDF_NAME.test(argument)) {
    return null;
  }

  if (isAbsolutePath(argument)) {
    return argument;
  }

  // `lexleaf book.pdf` from a terminal: relative to where it was typed.
  return workingDirectory === null ? null : resolve(workingDirectory, argument);
};

export const parseDocumentArgument = (
  argv: readonly string[],
  workingDirectory: string | null = null,
): string | null => {
  for (const argument of argv) {
    if (argument.startsWith(SWITCH)) {
      const path = argument.slice(SWITCH.length).trim();

      if (path !== '') {
        return path;
      }
    }
  }

  // The first entry is the executable itself.
  for (const argument of argv.slice(1)) {
    const path = positionalDocument(argument, workingDirectory);

    if (path !== null) {
      return path;
    }
  }

  return null;
};

/**
 * A document dropped onto the window.
 *
 * The path arrives over IPC, so it is held to the same shape a file
 * manager would have produced: an absolute path ending in `.pdf`. As
 * above, this only selects a file for the open pipeline.
 */
export const parseDroppedDocumentPath = (raw: unknown): string | null =>
  typeof raw === 'string' &&
  raw.length > 0 &&
  raw.length <= 4096 &&
  !raw.includes('\0') &&
  isAbsolutePath(raw) &&
  PDF_NAME.test(raw)
    ? raw
    : null;
