/**
 * The notices that ship with the application, and how to find them.
 *
 * Two kinds of material are licensed to the reader rather than to us: the
 * dictionary data, which is under CC BY 4.0 and the Princeton WordNet
 * licence, and anything the application redistributes under its own terms.
 * Both are text files in the installed application, and both must be
 * readable from inside it: pointing a reader at a file they cannot open is
 * not attribution.
 *
 * The files are small and are read whole. Nothing here is writable, nothing
 * accepts a path, and the caller gets text or a closed reason — never an
 * `errno`, never a directory name.
 */

/** The material a licence panel can show. */
export type LicenceDocumentId = 'application' | 'dictionary';

export const LICENCE_DOCUMENT_IDS: readonly LicenceDocumentId[] = ['application', 'dictionary'];

/** Where a document comes from, so the panel can say so when it is missing. */
export interface LicenceSources {
  /** `app.getAppPath()`: the application directory, or the asar archive. */
  readonly appPath: string;
  /** `process.resourcesPath` in a packaged app, otherwise `null`. */
  readonly resourcesPath: string | null;
  readonly packaged: boolean;
  /** Directory holding the dictionary artifact, or `null` when it is absent. */
  readonly dictionaryDirectory: string | null;
}

export interface LicenceDocument {
  readonly id: LicenceDocumentId;
  readonly title: string;
  readonly text: string;
}

export type LicenceFailure = 'not-installed' | 'unreadable';

export type LicenceReadResult =
  | { readonly ok: true; readonly value: LicenceDocument }
  | { readonly ok: false; readonly reason: LicenceFailure };

const joinPath = (...parts: readonly string[]): string => parts.join('/').replace(/\/{2,}/gu, '/');

export const APPLICATION_LICENCE_FILE = 'LICENSE';
export const APPLICATION_NOTICE_FILE = 'NOTICE';
export const DICTIONARY_NOTICE_FILE = 'NOTICE.md';

/**
 * The two files shown as one document.
 *
 * Apache-2.0 §4 says the License and the NOTICE travel together, so the
 * panel shows them together: a reader should not have to know which is
 * which to find out who to credit.
 */
const APPLICATION_DOCUMENTS = [APPLICATION_LICENCE_FILE, APPLICATION_NOTICE_FILE] as const;

const TITLES: Record<LicenceDocumentId, string> = {
  application: 'Lexleaf — Apache License 2.0 and notices',
  dictionary: 'Dictionary data — third-party notices',
};

/**
 * Candidate directories for the application's own files, in order.
 *
 * Packaged builds read them from beside the asar archive first (an
 * `asarUnpack`ed copy), then from inside it, which is where `files:` in
 * `electron-builder.yml` puts them. Development and the built output read
 * the project root.
 */
export const applicationDocumentCandidates = ({
  appPath,
  resourcesPath,
  packaged,
}: LicenceSources): readonly string[] => {
  const candidates: string[] = [];

  if (packaged && resourcesPath !== null) {
    candidates.push(joinPath(resourcesPath, 'app.asar.unpacked'));
    candidates.push(joinPath(resourcesPath, 'app.asar'));
  }

  // `appPath` is the asar archive itself in a packaged build, so it is
  // usually already listed; pushing it again would only read the same
  // directory twice.
  if (!candidates.includes(appPath)) {
    candidates.push(appPath);
  }

  return candidates;
};

/** Where the dictionary's own notice lives, if the artifact is installed. */
export const dictionaryNoticePath = (sources: LicenceSources): string | null =>
  sources.dictionaryDirectory === null
    ? null
    : joinPath(sources.dictionaryDirectory, DICTIONARY_NOTICE_FILE);

export interface LicenceReadDeps {
  /**
   * Reads a file as UTF-8. `null` when it does not exist.
   *
   * Injected so that the asar archive, which cannot be read with
   * `readFileSync`, can be read by the caller in the main process without
   * this module knowing that asar exists.
   */
  readonly readText: (path: string) => string | null;
}

/**
 * Reads one document.
 *
 * A document that is absent is `not-installed`; one that exists but cannot
 * be read or decoded is `unreadable`. The distinction matters to the panel:
 * the first is a build that shipped without its notices, the second is a
 * file that is damaged.
 */
export const readLicenceDocument = (
  id: LicenceDocumentId,
  sources: LicenceSources,
  { readText }: LicenceReadDeps,
): LicenceReadResult => {
  const texts: string[] = [];

  if (id === 'dictionary') {
    const path = dictionaryNoticePath(sources);

    if (path === null) {
      return { ok: false, reason: 'not-installed' };
    }

    const text = readText(path);

    return text === null
      ? { ok: false, reason: 'not-installed' }
      : { ok: true, value: { id, title: TITLES[id], text } };
  }

  for (const directory of applicationDocumentCandidates(sources)) {
    const parts: string[] = [];

    for (const name of APPLICATION_DOCUMENTS) {
      const text = readText(joinPath(directory, name));

      if (text !== null) {
        parts.push(text.trimEnd());
      }
    }

    // Both files or neither: half of the licence pair is not the licence.
    if (parts.length === APPLICATION_DOCUMENTS.length) {
      texts.push(...parts);

      return { ok: true, value: { id, title: TITLES[id], text: texts.join('\n\n') } };
    }
  }

  return { ok: false, reason: 'not-installed' };
};

/**
 * Why a document could not be shown.
 *
 * A closed set of sentences, so the panel cannot print a path or an error
 * message from the main process.
 */
export const LICENCE_FAILURE_MESSAGES: Record<LicenceFailure, string> = {
  'not-installed': 'These notices were not included in this build.',
  unreadable: 'These notices could not be read.',
};

/** Makes an unreadable file a failure rather than an exception. */
export const readLicenceDocumentSafely = (
  id: LicenceDocumentId,
  sources: LicenceSources,
  deps: LicenceReadDeps,
): LicenceReadResult => {
  try {
    return readLicenceDocument(id, sources, deps);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
};
