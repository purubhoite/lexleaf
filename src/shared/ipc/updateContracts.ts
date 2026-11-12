import { formatReleaseVersion, parseReleaseVersion } from '@core/update/version';

/**
 * What the renderer may know and say about updates.
 *
 * The renderer never names an address, a repository or a version of its
 * own. It can ask for a check, switch the automatic check on or off, and
 * ask the main process to open the download page for the release the main
 * process itself found. Everything coming back is a closed set of words
 * and, at most, one validated version number.
 */

export type UpdateOutcome =
  | { readonly status: 'idle' }
  | { readonly status: 'up-to-date' }
  | { readonly status: 'available'; readonly version: string }
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

  switch (value['status']) {
    case 'idle':
      return { status: 'idle' };
    case 'up-to-date':
      return { status: 'up-to-date' };
    case 'failed':
      return { status: 'failed' };
    case 'available': {
      const version = parseReleaseVersion(value['version']);

      return version === null
        ? null
        : { status: 'available', version: formatReleaseVersion(version) };
    }
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

/** The one argument of a check request. Anything but `true` is automatic. */
export const parseCheckRequest = (value: unknown): { readonly manual: boolean } | null =>
  isObject(value) && typeof value['manual'] === 'boolean' ? { manual: value['manual'] } : null;

export const parseSetAutomaticRequest = (value: unknown): { readonly automatic: boolean } | null =>
  isObject(value) && typeof value['automatic'] === 'boolean'
    ? { automatic: value['automatic'] }
    : null;
