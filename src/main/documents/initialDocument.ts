/**
 * The document named on the command line.
 *
 * Only an explicit `--open-document=<path>` switch is honoured: positional
 * arguments are ignored because Electron and Chromium add their own, and a
 * stray argument must never cause the application to read a file.
 */
const SWITCH = '--open-document=';

export const parseDocumentArgument = (argv: readonly string[]): string | null => {
  for (const argument of argv) {
    if (argument.startsWith(SWITCH)) {
      const path = argument.slice(SWITCH.length).trim();

      if (path !== '') {
        return path;
      }
    }
  }

  return null;
};
