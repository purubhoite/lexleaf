import { formatReleaseVersion, parseReleaseVersion } from '@core/update/version';

/**
 * What the renderer may know and say about updates.
 *
 * The renderer never names an address, a repository or a version of its
 * own. It can ask for a check, switch the automatic check on or off, ask
 * for the update the main process found to be downloaded and installed,
 * and ask for that release's download page to be opened. Everything
 * coming back is a closed set of words and, at most, one validated
 * version number.
 */

export type UpdateOutcome =
  | { readonly status: 'idle' }
  | { readonly status: 'up-to-date' }
  /**
   * A newer release exists. `canInstall` says whether this installation
   * can download and install it itself; otherwise the reader is pointed
   * at the download page.
   */
  | { readonly status: 'available'; readonly version: string; readonly canInstall: boolean }
  | { readonly status: 'downloading'; readonly version: string }
  /** Downloaded and verified; it is installed when the reader says so. */
  | { readonly status: 'ready'; readonly version: string }
  /** The download did not complete. The download page still works. */
  | { readonly status: 'download-failed'; readonly version: string }
  /** The check itself could not be made. */
  | { readonly status: 'failed' };

export interface UpdateIpcState {
  /** Whether Lexleaf checks by itself, at most once a day. */
  readonly automatic: boolean;
  readonly outcome: UpdateOutcome;
}

export interface UpdateBridge {
  /**
   * Asks for a check. `manual` is true when the reader pressed the button;
   * otherwise the main process applies the reader's setting and the daily
   * limit, and may answer without contacting anything.
   */
  readonly check: (manual: boolean) => Promise<UpdateIpcState>;
  readonly setAutomatic: (automatic: boolean) => Promise<UpdateIpcState>;
  /**
   * Downloads the release the main process found. Resolves when the
   * download has finished, one way or the other. Nothing is installed.
   */
  readonly download: () => Promise<UpdateIpcState>;
  /** Closes Lexleaf, installs the downloaded release and starts it again. */
  readonly install: () => Promise<void>;
  /** Opens the download page of the available release in the browser. */
  readonly openDownload: () => Promise<void>;
}

/** What is shown when the main process says something unexpected. */
export const UPDATE_STATE_UNKNOWN: UpdateIpcState = {
  automatic: true,
  outcome: { status: 'idle' },
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseOutcome = (value: unknown): UpdateOutcome | null => {
  if (!isObject(value)) {
    return null;
  }

  const status = value['status'];

  if (status === 'idle' || status === 'up-to-date' || status === 'failed') {
    return { status };
  }

  const parsed = parseReleaseVersion(value['version']);

  if (parsed === null) {
    return null;
  }

  const version = formatReleaseVersion(parsed);

  switch (status) {
    case 'available':
      // Only an explicit `true` offers the in-app install.
      return { status, version, canInstall: value['canInstall'] === true };
    case 'downloading':
    case 'ready':
    case 'download-failed':
      return { status, version };
    default:
      return null;
  }
};

export const parseUpdateState = (value: unknown): UpdateIpcState | null => {
  if (!isObject(value) || typeof value['automatic'] !== 'boolean') {
    return null;
  }

  const outcome = parseOutcome(value['outcome']);

  return outcome === null ? null : { automatic: value['automatic'], outcome };
};

/** The one argument of a check request. */
export const parseCheckRequest = (value: unknown): { readonly manual: boolean } | null =>
  isObject(value) && typeof value['manual'] === 'boolean' ? { manual: value['manual'] } : null;

export const parseSetAutomaticRequest = (value: unknown): { readonly automatic: boolean } | null =>
  isObject(value) && typeof value['automatic'] === 'boolean'
    ? { automatic: value['automatic'] }
    : null;
