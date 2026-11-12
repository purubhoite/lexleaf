/**
 * Release versions, and the one question the update check asks of them.
 *
 * Lexleaf publishes plain `major.minor.patch` versions. Anything else —
 * a pre-release suffix, build metadata, a fourth component — is treated as
 * "not a version this build understands" rather than guessed at: telling a
 * reader that an update exists when it does not is worse than saying
 * nothing.
 */

export type ReleaseVersion = readonly [major: number, minor: number, patch: number];

const VERSION_PATTERN = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/u;

/** Parses `1.2.3` or `v1.2.3`. Returns `null` for anything else. */
export const parseReleaseVersion = (value: unknown): ReleaseVersion | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const match = VERSION_PATTERN.exec(value.trim());

  if (match === null) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const formatReleaseVersion = (version: ReleaseVersion): string => version.join('.');

/** True only when `candidate` is strictly newer than `current`. */
export const isNewerVersion = (candidate: ReleaseVersion, current: ReleaseVersion): boolean => {
  for (let index = 0; index < 3; index += 1) {
    const left = candidate[index] ?? 0;
    const right = current[index] ?? 0;

    if (left !== right) {
      return left > right;
    }
  }

  return false;
};

/**
 * Reads the version out of a "latest release" reply.
 *
 * The reply is untrusted input. Only the tag name is read, and only when
 * the release is neither a draft nor a pre-release; no address in the
 * reply is ever used.
 */
export const parseLatestRelease = (payload: unknown): ReleaseVersion | null => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }

  const release = payload as Record<string, unknown>;

  if (release['draft'] === true || release['prerelease'] === true) {
    return null;
  }

  return parseReleaseVersion(release['tag_name']);
};
