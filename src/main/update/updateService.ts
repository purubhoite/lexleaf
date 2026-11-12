import {
  formatReleaseVersion,
  isNewerVersion,
  parseLatestRelease,
  parseReleaseVersion,
  type ReleaseVersion,
} from '@core/update/version';
import type { UpdateIpcState, UpdateOutcome } from '@shared/ipc/updateContracts';

import type { UpdateSettingsStore } from './updateSettings';

/**
 * Finds out whether a newer Lexleaf has been released, and says so.
 *
 * This is a notice, not an updater: nothing is downloaded and nothing is
 * installed. The service asks one fixed public address for the latest
 * release, compares its version with the running one, and remembers the
 * answer. The reader decides what to do about it.
 *
 * The rules, all enforced below and tested:
 *
 * - **One fixed destination.** The address is a constant of this module.
 *   Nothing from the renderer, a file or the reply can change it, and the
 *   download page that is opened is built here from a validated version
 *   number, never taken from the reply.
 * - **Nothing about the reader is sent.** The request carries no body, no
 *   identifier and no credentials.
 * - **The reader's setting is the authority.** With the automatic check
 *   off, only a check the reader asked for by hand contacts anything.
 * - **At most once a day** for the automatic check. A launch inside that
 *   window answers from what the last check saw.
 * - **Never in the way.** Every failure is the word `failed` or silence;
 *   nothing here throws at a caller.
 */

/** The public record of the latest release. */
export const LATEST_RELEASE_ADDRESS =
  'https://api.github.com/repos/purubhoite/lexleaf/releases/latest';

const RELEASE_PAGE_PREFIX = 'https://github.com/purubhoite/lexleaf/releases/tag/v';

/** How long an answered automatic check is good for. */
export const AUTOMATIC_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The page a reader downloads a given version from. */
export const releasePageFor = (version: ReleaseVersion): string =>
  `${RELEASE_PAGE_PREFIX}${formatReleaseVersion(version)}`;

export interface UpdateServiceOptions {
  /** The running version, from the application's own metadata. */
  readonly currentVersion: string;
  readonly settings: UpdateSettingsStore;
  /** Fetches and decodes the latest-release record. Rejects on any failure. */
  readonly fetchLatestRelease: (address: string) => Promise<unknown>;
  readonly openExternal: (address: string) => void;
  readonly now: () => Date;
  /** False in development, where the automatic check stays quiet. */
  readonly automaticChecksAllowed?: boolean;
  readonly onDiagnostic?: (message: string) => void;
}

export interface UpdateService {
  check(request: { readonly manual: boolean }): Promise<UpdateIpcState>;
  setAutomatic(automatic: boolean): Promise<UpdateIpcState>;
  openDownload(): void;
}

export const createUpdateService = ({
  currentVersion,
  settings,
  fetchLatestRelease,
  openExternal,
  now,
  automaticChecksAllowed = true,
  onDiagnostic = (): void => {},
}: UpdateServiceOptions): UpdateService => {
  const current = parseReleaseVersion(currentVersion);
  let available: ReleaseVersion | null = null;
  let inFlight: Promise<UpdateOutcome> | null = null;

  const outcomeFor = (latest: ReleaseVersion | null): UpdateOutcome => {
    if (current === null || latest === null || !isNewerVersion(latest, current)) {
      available = null;

      return { status: 'up-to-date' };
    }

    available = latest;

    return { status: 'available', version: formatReleaseVersion(latest) };
  };

  const contact = async (): Promise<UpdateOutcome> => {
    try {
      const latest = parseLatestRelease(await fetchLatestRelease(LATEST_RELEASE_ADDRESS));

      if (latest === null) {
        onDiagnostic('update check: the reply did not name a release');

        return { status: 'failed' };
      }

      const stored = await settings.read();

      await settings.write({
        ...stored,
        lastCheckedAt: now().toISOString(),
        latestSeenVersion: formatReleaseVersion(latest),
      });

      return outcomeFor(latest);
    } catch (error) {
      onDiagnostic(`update check failed: ${error instanceof Error ? error.name : 'unknown'}`);

      return { status: 'failed' };
    }
  };

  /** One request at a time: a second caller waits for the first answer. */
  const contactOnce = (): Promise<UpdateOutcome> => {
    inFlight ??= contact().finally(() => {
      inFlight = null;
    });

    return inFlight;
  };

  const isFresh = (lastCheckedAt: string | null): boolean => {
    if (lastCheckedAt === null) {
      return false;
    }

    const elapsed = now().getTime() - Date.parse(lastCheckedAt);

    // A clock that has gone backwards makes the stored time "in the
    // future"; that is not fresh, it is unknown.
    return elapsed >= 0 && elapsed < AUTOMATIC_CHECK_INTERVAL_MS;
  };

  return {
    check: async ({ manual }): Promise<UpdateIpcState> => {
      const stored = await settings.read();

      if (current === null) {
        // A build that cannot name its own version cannot compare one.
        return { automatic: stored.automatic, outcome: { status: 'idle' } };
      }

      if (manual) {
        return { automatic: stored.automatic, outcome: await contactOnce() };
      }

      if (!stored.automatic || !automaticChecksAllowed) {
        return { automatic: stored.automatic, outcome: { status: 'idle' } };
      }

      if (isFresh(stored.lastCheckedAt)) {
        return {
          automatic: true,
          outcome: outcomeFor(parseReleaseVersion(stored.latestSeenVersion)),
        };
      }

      const outcome = await contactOnce();

      // An automatic check that failed says nothing: the reader did not
      // ask, and being offline is not news.
      return {
        automatic: true,
        outcome: outcome.status === 'failed' ? { status: 'idle' } : outcome,
      };
    },
    setAutomatic: async (automatic): Promise<UpdateIpcState> => {
      const stored = await settings.read();

      await settings.write({ ...stored, automatic });

      return {
        automatic,
        outcome:
          available === null
            ? { status: 'idle' }
            : { status: 'available', version: formatReleaseVersion(available) },
      };
    },
    openDownload: (): void => {
      if (available !== null) {
        openExternal(releasePageFor(available));
      }
    },
  };
};
