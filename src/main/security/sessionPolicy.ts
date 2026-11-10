import { buildContentSecurityPolicy } from './contentSecurityPolicy';

/** Minimal structural view of the Electron `Session` API used here. */
export interface SecurableSession {
  readonly webRequest: {
    onHeadersReceived(
      listener: (
        details: { responseHeaders?: Record<string, string[]> },
        callback: (response: { responseHeaders: Record<string, string[]> }) => void,
      ) => void,
    ): void;
  };
  setPermissionRequestHandler(
    handler:
      | ((webContents: unknown, permission: string, callback: (granted: boolean) => void) => void)
      | null,
  ): void;
  setPermissionCheckHandler(
    handler: ((webContents: unknown, permission: string) => boolean) | null,
  ): void;
}

const CSP_HEADER = 'Content-Security-Policy';

const withoutExistingCspHeaders = (headers: Record<string, string[]>): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== CSP_HEADER.toLowerCase()),
  );

/**
 * Applies session-wide protections:
 *
 * - a Content Security Policy on every response (replacing any supplied one);
 * - denial of all runtime permission requests, since the reader needs none.
 */
export const applySessionSecurityPolicies = (
  session: SecurableSession,
  devServerOrigin: string | null,
): void => {
  const policy = buildContentSecurityPolicy(devServerOrigin);

  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...withoutExistingCspHeaders(details.responseHeaders ?? {}),
        [CSP_HEADER]: [policy],
      },
    });
  });

  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  session.setPermissionCheckHandler(() => false);
};
