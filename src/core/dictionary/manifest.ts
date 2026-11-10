import type { DictionaryAttribution, DictionaryLicence } from './types';

/**
 * The artifact manifest.
 *
 * The build pipeline writes it next to the data, and it is the single source
 * of truth for everything the application has to be able to state about the
 * dictionary it ships: which release it was built from, what the upstream
 * download hashed to, which licences apply, that the data was modified, and
 * what the generated files hash to. The in-app attribution affordance and
 * the generated third-party notice both derive from this one file, so they
 * cannot drift apart.
 *
 * It is parsed as untrusted input: a manifest that does not validate makes
 * the dictionary unavailable rather than producing an unattributed answer.
 */

export interface DictionaryManifestFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface DictionaryManifestSource {
  readonly dataset: string;
  readonly release: string;
  readonly archiveUrl: string;
  readonly archiveSha256: string;
  readonly pronunciationUrl: string;
  readonly pronunciationSha256: string;
}

export interface DictionaryManifest {
  readonly formatVersion: number;
  readonly transformVersion: string;
  readonly source: DictionaryManifestSource;
  readonly licences: readonly DictionaryLicence[];
  readonly modified: boolean;
  readonly modificationStatement: string;
  readonly credits: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
  readonly files: readonly DictionaryManifestFile[];
}

export const MANIFEST_FORMAT_VERSION = 1;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const parseLicences = (value: unknown): readonly DictionaryLicence[] | null => {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const licences: DictionaryLicence[] = [];

  for (const candidate of value) {
    if (!isObject(candidate)) {
      return null;
    }

    const name = text(candidate['name']);
    const url = text(candidate['url']);

    if (name === null || url === null) {
      return null;
    }

    licences.push({ name, url });
  }

  return licences;
};

const parseSource = (value: unknown): DictionaryManifestSource | null => {
  if (!isObject(value)) {
    return null;
  }

  const dataset = text(value['dataset']);
  const release = text(value['release']);
  const archiveUrl = text(value['archiveUrl']);
  const archiveSha256 = text(value['archiveSha256']);
  const pronunciationUrl = text(value['pronunciationUrl']);
  const pronunciationSha256 = text(value['pronunciationSha256']);

  if (
    dataset === null ||
    release === null ||
    archiveUrl === null ||
    archiveSha256 === null ||
    pronunciationUrl === null ||
    pronunciationSha256 === null
  ) {
    return null;
  }

  return {
    dataset,
    release,
    archiveUrl,
    archiveSha256,
    pronunciationUrl,
    pronunciationSha256,
  };
};

const parseFiles = (value: unknown): readonly DictionaryManifestFile[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const files: DictionaryManifestFile[] = [];

  for (const candidate of value) {
    if (!isObject(candidate)) {
      return null;
    }

    const name = text(candidate['name']);
    const sha256 = text(candidate['sha256']);
    const bytes = candidate['bytes'];

    if (name === null || sha256 === null || typeof bytes !== 'number' || !Number.isFinite(bytes)) {
      return null;
    }

    files.push({ name, bytes, sha256 });
  }

  return files;
};

const parseCounts = (value: unknown): Readonly<Record<string, number>> => {
  if (!isObject(value)) {
    return {};
  }

  const counts: Record<string, number> = {};

  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      counts[key] = candidate;
    }
  }

  return counts;
};

/** Parses manifest JSON. Returns `null` rather than a repaired guess. */
export const parseDictionaryManifest = (contents: string): DictionaryManifest | null => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }

  if (!isObject(parsed)) {
    return null;
  }

  const source = parseSource(parsed['source']);
  const licences = parseLicences(parsed['licences']);
  const files = parseFiles(parsed['files']);
  const transformVersion = text(parsed['transformVersion']);
  const modificationStatement = text(parsed['modificationStatement']);
  const credits = Array.isArray(parsed['credits'])
    ? parsed['credits'].filter((credit): credit is string => typeof credit === 'string')
    : null;

  if (
    parsed['formatVersion'] !== MANIFEST_FORMAT_VERSION ||
    source === null ||
    licences === null ||
    files === null ||
    credits === null ||
    credits.length === 0 ||
    transformVersion === null ||
    modificationStatement === null ||
    parsed['modified'] !== true
  ) {
    return null;
  }

  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    transformVersion,
    source,
    licences,
    modified: true,
    modificationStatement,
    credits,
    counts: parseCounts(parsed['counts']),
    files,
  };
};

/** The attribution stamped on every answer, derived from the manifest. */
export const attributionFrom = (manifest: DictionaryManifest): DictionaryAttribution => ({
  datasetName: manifest.source.dataset,
  release: manifest.source.release,
  licences: manifest.licences,
  modified: manifest.modified,
  modificationStatement: manifest.modificationStatement,
  credits: manifest.credits,
});
