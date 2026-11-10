import type { AppInfo } from '@shared/ipc/contracts';

/** Values the main process reads from the Electron runtime. */
export interface AppInfoSource {
  readonly name: string;
  readonly version: string;
  readonly electronVersion: string | undefined;
  readonly chromeVersion: string | undefined;
}

const UNKNOWN_VERSION = 'unknown';

const orUnknown = (value: string | undefined): string =>
  value === undefined || value === '' ? UNKNOWN_VERSION : value;

/**
 * Builds the payload returned over {@link IpcChannel.GetAppInfo}.
 *
 * Only static, non-sensitive values are exposed; nothing here reveals
 * filesystem paths, user data or machine identity.
 */
export const createAppInfo = (source: AppInfoSource): AppInfo => ({
  name: source.name,
  version: source.version,
  electronVersion: orUnknown(source.electronVersion),
  chromeVersion: orUnknown(source.chromeVersion),
});
