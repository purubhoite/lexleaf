/**
 * Where the dictionary artifact lives.
 *
 * Three situations have to work, and the renderer has a say in none of them:
 * running from source during development, running the built output, and
 * running a packaged application. The candidate list is fixed in code, the
 * first directory containing a manifest wins, and nothing is ever resolved
 * from a path supplied over IPC.
 *
 * Packaging intent: the artifact is shipped **unpacked** next to the asar
 * archive (`resources/dictionary`). It is read with positional reads at
 * runtime, which an asar archive cannot serve, and it is a third-party
 * dataset that must stay inspectable for the licence notices to be
 * meaningful.
 */

export interface ArtifactLocationOptions {
  /** `app.getAppPath()`: the application directory, or the asar archive. */
  readonly appPath: string;
  /** `process.resourcesPath` in a packaged app, otherwise `null`. */
  readonly resourcesPath: string | null;
  readonly packaged: boolean;
}

const DIRECTORY_NAME = 'dictionary';

const joinPath = (...parts: readonly string[]): string => parts.join('/').replace(/\/{2,}/gu, '/');

/**
 * The directories to try, in order.
 *
 * Exported so the ordering itself can be asserted: an installed application
 * must prefer the artifact shipped beside it over anything else.
 */
export const artifactCandidates = ({
  appPath,
  resourcesPath,
  packaged,
}: ArtifactLocationOptions): readonly string[] => {
  const candidates: string[] = [];

  if (packaged && resourcesPath !== null) {
    // Unpacked beside the asar archive.
    candidates.push(joinPath(resourcesPath, DIRECTORY_NAME));
    candidates.push(joinPath(resourcesPath, 'app.asar.unpacked', 'resources', DIRECTORY_NAME));
  }

  // Development (`electron-vite dev`) and the built output both run with the
  // project root as the application path.
  candidates.push(joinPath(appPath, 'resources', DIRECTORY_NAME));

  return candidates;
};

/**
 * Picks the first candidate that looks like an artifact directory.
 *
 * @param hasManifest tests whether a directory contains `manifest.json`
 * @returns the directory, or `null` when the dictionary is not installed
 */
export const resolveArtifactDirectory = (
  options: ArtifactLocationOptions,
  hasManifest: (directory: string) => boolean,
): string | null => artifactCandidates(options).find((candidate) => hasManifest(candidate)) ?? null;
