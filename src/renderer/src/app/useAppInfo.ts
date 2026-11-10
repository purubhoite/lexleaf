import { useEffect, useState } from 'react';

import type { AppInfo, DesktopBridge } from '@shared/ipc/contracts';

/**
 * Why application details could not be read.
 *
 * A closed set, not a message and not an error object. Until the 6.5
 * closure pass this hook put `error.message` into the state and the shell
 * printed it, so a rejected IPC call reached the reader as raw engine
 * wording — and 6.5 had just promoted that line to an `alert`, so it was
 * read out as well (6.5 acceptance audit, C-3). A union cannot carry a
 * path, a URL or a stack: the sanitisation is the type.
 */
export type AppInfoFailure = 'bridge-unavailable' | 'request-failed';

export type AppInfoState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly appInfo: AppInfo }
  | { readonly status: 'unavailable'; readonly reason: AppInfoFailure };

/**
 * The sentence shown for each failure, in one place so that the wording
 * cannot drift and nothing else can invent one.
 */
export const APP_INFO_FAILURE_MESSAGES: Record<AppInfoFailure, string> = {
  'bridge-unavailable': 'The desktop bridge is unavailable.',
  'request-failed': 'The main process did not answer.',
};

const LOADING: AppInfoState = { status: 'loading' };
const BRIDGE_UNAVAILABLE: AppInfoState = {
  status: 'unavailable',
  reason: 'bridge-unavailable',
};

interface LoadedState {
  /** Bridge the result came from, so a replaced bridge cannot show stale data. */
  readonly source: DesktopBridge;
  readonly state: AppInfoState;
}

/**
 * Loads application details through the desktop bridge.
 *
 * Failure is a normal state rather than an exception: the window must stay
 * usable when the bridge is missing or the main process cannot answer.
 */
export const useAppInfo = (bridge: DesktopBridge | null): AppInfoState => {
  const [loaded, setLoaded] = useState<LoadedState | null>(null);

  useEffect(() => {
    if (bridge === null) {
      return undefined;
    }

    let active = true;

    void bridge
      .getAppInfo()
      .then((appInfo) => {
        if (active) {
          setLoaded({ source: bridge, state: { status: 'ready', appInfo } });
        }
      })
      .catch(() => {
        if (active) {
          // The rejection itself is deliberately not inspected: whatever it
          // says, the reader is told the same thing, and nothing the main
          // process wrote can reach the window through here.
          setLoaded({
            source: bridge,
            state: { status: 'unavailable', reason: 'request-failed' },
          });
        }
      });

    return (): void => {
      active = false;
    };
  }, [bridge]);

  if (bridge === null) {
    return BRIDGE_UNAVAILABLE;
  }

  return loaded !== null && loaded.source === bridge ? loaded.state : LOADING;
};
