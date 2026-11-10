import { DESKTOP_BRIDGE_KEY, type DesktopBridge } from '@shared/ipc/contracts';

/**
 * Reads the bridge installed by the preload script.
 *
 * The renderer must keep working when the bridge is absent (for example in
 * component tests, or if the preload script failed to load), so callers get
 * `null` rather than an exception.
 */
export const resolveDesktopBridge = (scope: unknown): DesktopBridge | null => {
  if (typeof scope !== 'object' || scope === null) {
    return null;
  }

  const candidate = (scope as Record<string, unknown>)[DESKTOP_BRIDGE_KEY];

  if (typeof candidate !== 'object' || candidate === null) {
    return null;
  }

  const { getAppInfo, openDocumentDialog, getInitialDocument } = candidate as Partial<
    Record<keyof DesktopBridge, unknown>
  >;

  if (
    typeof getAppInfo !== 'function' ||
    typeof openDocumentDialog !== 'function' ||
    typeof getInitialDocument !== 'function'
  ) {
    return null;
  }

  return candidate as DesktopBridge;
};
