import { describe, expect, it } from 'vitest';

import { applySessionSecurityPolicies, type SecurableSession } from './sessionPolicy';

interface FakeSession extends SecurableSession {
  readonly respondWith: (headers: Record<string, string[]>) => Record<string, string[]>;
  readonly requestPermission: (permission: string) => boolean;
  readonly checkPermission: (permission: string) => boolean;
}

const createFakeSession = (): FakeSession => {
  let headersListener:
    | ((
        details: { responseHeaders?: Record<string, string[]> },
        callback: (response: { responseHeaders: Record<string, string[]> }) => void,
      ) => void)
    | null = null;
  let permissionRequestHandler:
    | ((webContents: unknown, permission: string, callback: (granted: boolean) => void) => void)
    | null = null;
  let permissionCheckHandler: ((webContents: unknown, permission: string) => boolean) | null = null;

  return {
    webRequest: {
      onHeadersReceived(listener): void {
        headersListener = listener;
      },
    },
    setPermissionRequestHandler(handler): void {
      permissionRequestHandler = handler;
    },
    setPermissionCheckHandler(handler): void {
      permissionCheckHandler = handler;
    },
    respondWith(headers): Record<string, string[]> {
      if (headersListener === null) {
        throw new Error('No response header listener registered.');
      }
      let result: Record<string, string[]> = {};
      headersListener({ responseHeaders: headers }, (response) => {
        result = response.responseHeaders;
      });
      return result;
    },
    requestPermission(permission): boolean {
      if (permissionRequestHandler === null) {
        throw new Error('No permission request handler registered.');
      }
      let granted = true;
      permissionRequestHandler(null, permission, (value) => {
        granted = value;
      });
      return granted;
    },
    checkPermission(permission): boolean {
      if (permissionCheckHandler === null) {
        throw new Error('No permission check handler registered.');
      }
      return permissionCheckHandler(null, permission);
    },
  };
};

describe('applySessionSecurityPolicies', () => {
  it('adds the content security policy to responses', () => {
    const session = createFakeSession();
    applySessionSecurityPolicies(session, null);

    const headers = session.respondWith({ 'content-type': ['text/html'] });

    expect(headers['Content-Security-Policy']).toEqual([
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ]);
  });

  it('preserves unrelated response headers', () => {
    const session = createFakeSession();
    applySessionSecurityPolicies(session, null);

    const headers = session.respondWith({ 'content-type': ['text/html'] });

    expect(headers['content-type']).toEqual(['text/html']);
  });

  it('replaces a policy supplied by the response instead of appending to it', () => {
    const session = createFakeSession();
    applySessionSecurityPolicies(session, null);

    const headers = session.respondWith({ 'content-security-policy': ['default-src *'] });

    expect(
      Object.keys(headers).filter((name) => name.toLowerCase() === 'content-security-policy'),
    ).toHaveLength(1);
    expect(headers['Content-Security-Policy']?.[0]).toContain("default-src 'none'");
  });

  it('tolerates a response without headers', () => {
    const session = createFakeSession();
    applySessionSecurityPolicies(session, null);

    expect(() => session.respondWith({})).not.toThrow();
  });

  it('denies every permission request', () => {
    const session = createFakeSession();
    applySessionSecurityPolicies(session, null);

    expect(session.requestPermission('media')).toBe(false);
    expect(session.requestPermission('geolocation')).toBe(false);
    expect(session.checkPermission('clipboard-read')).toBe(false);
  });
});
