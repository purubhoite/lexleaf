import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseDictionaryManifest } from '@core/dictionary/manifest';

/**
 * Which build of the dictionary artifact a snapshot came from.
 *
 * The dictionary's own attribution carries the dataset and its release, but
 * not the version of the transform that turned that dataset into the file
 * this application reads. A saved word records both, so that a definition
 * kept today can still be explained after the artifact is rebuilt
 * (ADR-025). Reading it is deliberately separate from the dictionary
 * service: the vocabulary needs one string, not a dictionary.
 *
 * The manifest is read at most once, and a failure is not an error worth
 * refusing a save over - the snapshot is stored with the honest
 * `unknown` version instead.
 */

const MANIFEST_FILE = 'manifest.json';

export interface TransformVersionReader {
  /** The transform version, or `null` when it cannot be read. */
  (): string | null;
}

export const createTransformVersionReader = (
  locate: () => string | null,
  readText: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): TransformVersionReader => {
  let resolved = false;
  let version: string | null = null;

  return (): string | null => {
    if (resolved) {
      return version;
    }

    resolved = true;

    const directory = locate();

    if (directory === null) {
      return null;
    }

    try {
      const manifest = parseDictionaryManifest(readText(join(directory, MANIFEST_FILE)));

      version = manifest?.transformVersion ?? null;
    } catch {
      version = null;
    }

    return version;
  };
};
