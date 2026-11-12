import {
  formatReleaseVersion,
  isNewerVersion,
  parseLatestRelease,
  parseReleaseVersion,
  type ReleaseVersion,
} from '@core/update/version';
import type { UpdateIpcState, UpdateOutcome } from '@shared/ipc/updateContracts';

import type { UpdateInstaller } from './updateInstaller';
import type { UpdateSettingsStore } from './updateSettings';

/**
 * Finds out whether a newer Lexleaf has been released, and says so.
 *
 * The service asks one fixed public address for the latest release,
 * compares its version with the running one, and remembers the answer.
 * Nothing is downloaded until the reader asks for it, and nothing is
 * installed until the reader asks again. An installation that cannot
 * replace itself has no installer and is pointed at the download page.
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
 * - **Two separate consents.** Finding an update never downloads it, and
 *   downloading it never installs it.
 * - **Never in the way.** Every failure is a word in the reply or silence;
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
  /** Present only when this installation can replace itself. */
  readonly installer?: UpdateInstaller | null;
  /** Runs before the application is closed to install, e.g. to save state. */
  readonly beforeInstall?: () => Promise<void>;
  readonly onDiagnostic?: (message: string) => void;
}

export interface UpdateService {
  check(request: { readonly manual: boolean }): Promise<UpdateIpcState>;
  setAutomatic(automatic: boolean): Promise<UpdateIpcState>;
  /** Downloads the release that was found. Resolves when it has finished. */
  download(): Promise<UpdateIpcState>;
  /** Installs the downloaded release, closing the application to do so. */
  install(): Promise<void>;
  openDownload(): void;
}

type DownloadPhase = 'none' | 'downloading' | 'ready' | 'failed';

export const createUpdateService = ({
  currentVersion,
  settings,
  fetchLatestRelease,
  openExternal,
  now,
  automaticChecksAllowed = true,
  installer = null,
  beforeInstall = async (): Promise<void> => {},
  onDiagnostic = (): void => {},
}: UpdateServiceOptions): UpdateService => {
  const current = parseReleaseVersion(currentVersion);
  let available: ReleaseVersion | null = null;
  let phase: DownloadPhase = 'none';
  let inFlight: Promise<UpdateOutcome> | null = null;
  let downloading: Promise<void> | null = null;

  /** What is known right now about the release that was found, if any. */
  const known = (): UpdateOutcome | null => {
    if (available === null) {
      return null;
    }

    const version = formatReleaseVersion(available);

    switch (phase) {
      case 'downloading':
        return { status: 'downloading', version };
      case 'ready':
        return { status: 'ready', version };
      case 'failed':
        return { status: 'download-failed', version };
      default:
        return { status: 'available', version, canInstall: installer !== null };
    }
  };

  const outcomeFor = (latest: ReleaseVersion | null): UpdateOutcome => {
    // A download that is running or finished is not thrown away by a
    // later check: what was downloaded is still what will be installed.
    if (phase === 'downloading' || phase === 'ready') {
      return known() ?? { status: 'up-to-date' };
    }

    if (current === null || latest === null || !isNewerVersion(latest, current)) {
      available = null;
      phase = 'none';

      return { status: 'up-to-date' };
    }

    if (available === null || isNewerVersion(latest, available)) {
      phase = 'none';
    }

    available = latest;

    return known() ?? { status: 'up-to-date' };
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

      return { automatic, outcome: known() ?? { status: 'idle' } };
    },
    download: async (): Promise<UpdateIpcState> => {
      const { automatic } = await settings.read();

      if (installer !== null && available !== null && phase !== 'ready') {
        if (downloading === null) {
          phase = 'downloading';
          downloading = installer
            .download()
            .then(
              () => {
                phase = 'ready';
              },
              (error: unknown) => {
                phase = 'failed';
                onDiagnostic(
                  `update download failed: ${error instanceof Error ? error.name : 'unknown'}`,
                );
              },
            )
            .finally(() => {
              downloading = null;
            });
        }

        await downloading;
      }

      return { automatic, outcome: known() ?? { status: 'idle' } };
    },
    install: async (): Promise<void> => {
      if (installer === null || phase !== 'ready') {
        return;
      }

      try {
        await beforeInstall();
      } catch {
        // Saving state is a courtesy; it does not get to block an update
        // the reader asked for.
      }

      installer.install();
    },
    openDownload: (): void => {
      if (available !== null) {
        openExternal(releasePageFor(available));
      }
    },
  };
};
