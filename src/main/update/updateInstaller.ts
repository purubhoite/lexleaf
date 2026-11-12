import { isNewerVersion, parseReleaseVersion } from '@core/update/version';

/**
 * Downloading and installing a release, behind a port.
 *
 * The update service decides *whether* there is something to install; this
 * is the part that fetches it and hands it to the operating system. It is
 * a thin adapter over `electron-updater`, kept behind an interface so the
 * service can be tested without it and so an installation that cannot
 * update itself simply has no installer.
 *
 * What the adapter insists on:
 *
 * - **Nothing happens by itself.** Automatic download and install-on-quit
 *   are both switched off; a download starts when the reader asks and an
 *   install starts when the reader asks again.
 * - **Only forwards.** Pre-releases and downgrades are refused, and a feed
 *   that does not offer something newer than the running build is treated
 *   as a failure rather than installed.
 * - **The library is loaded on first use.** A build in which it cannot be
 *   loaded still starts, still reads and still offers the download page.
 *
 * The download is checked against the SHA-512 published with the release
 * before it is accepted. The installer is not code signed, so that hash is
 * the integrity check there is; see the README.
 */

export interface UpdateInstaller {
  /** Downloads the newest release. Rejects if it cannot, or if there is none. */
  download(): Promise<void>;
  /** Closes the application, installs what was downloaded and restarts. */
  install(): void;
}

/** The part of `electron-updater` this adapter uses. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  checkForUpdates(): Promise<{ readonly updateInfo: { readonly version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface ElectronUpdaterInstallerOptions {
  readonly currentVersion: string;
  /** Loads the library. Injected so the module is only evaluated on use. */
  readonly load: () => Promise<AutoUpdaterLike>;
  readonly onDiagnostic?: (message: string) => void;
}

export const createElectronUpdaterInstaller = ({
  currentVersion,
  load,
  onDiagnostic = (): void => {},
}: ElectronUpdaterInstallerOptions): UpdateInstaller => {
  let updater: AutoUpdaterLike | null = null;
  let downloaded = false;

  const configured = async (): Promise<AutoUpdaterLike> => {
    if (updater === null) {
      const loaded = await load();

      loaded.autoDownload = false;
      loaded.autoInstallOnAppQuit = false;
      loaded.allowPrerelease = false;
      loaded.allowDowngrade = false;
      updater = loaded;
    }

    return updater;
  };

  return {
    download: async (): Promise<void> => {
      const active = await configured();
      const result = await active.checkForUpdates();
      const offered = parseReleaseVersion(result?.updateInfo.version);
      const current = parseReleaseVersion(currentVersion);

      if (offered === null || current === null || !isNewerVersion(offered, current)) {
        throw new Error('the update feed did not offer a newer release');
      }

      await active.downloadUpdate();
      downloaded = true;
      onDiagnostic('update downloaded and verified');
    },
    install: (): void => {
      if (!downloaded || updater === null) {
        return;
      }

      // Silent, and started again afterwards: the reader asked for
      // "restart and install", not for an installer wizard.
      updater.quitAndInstall(true, true);
    },
  };
};

/** Whether this installation is of a kind that can replace itself. */
export const canInstallUpdates = ({
  packaged,
  platform,
  env,
}: {
  readonly packaged: boolean;
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): boolean => {
  if (!packaged) {
    return false;
  }

  if (platform === 'win32') {
    return true;
  }

  // On Linux only an AppImage can replace itself; a Debian package belongs
  // to the system's package manager and is pointed at the download page.
  return platform === 'linux' && (env['APPIMAGE'] ?? '').length > 0;
};
