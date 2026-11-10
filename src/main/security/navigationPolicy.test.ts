import { describe, expect, it, vi } from 'vitest';

import {
  applyWebContentsSecurityPolicies,
  isApplicationUrl,
  isSafeExternalUrl,
  type GuardedWebContents,
} from './navigationPolicy';

const DEV_ORIGIN = 'http://localhost:5173';

describe('isApplicationUrl', () => {
  it('accepts the packaged renderer loaded from disk', () => {
    expect(isApplicationUrl('file:///app/out/renderer/index.html', null)).toBe(true);
  });

  it('accepts the dev server while developing', () => {
    expect(isApplicationUrl(`${DEV_ORIGIN}/index.html`, DEV_ORIGIN)).toBe(true);
  });

  it('rejects the dev server in production', () => {
    expect(isApplicationUrl(`${DEV_ORIGIN}/index.html`, null)).toBe(false);
  });

  it.each([
    'https://example.com',
    'http://localhost:9999/index.html',
    'data:text/html,<script></script>',
    'javascript:alert(1)',
    'not a url',
  ])('rejects %s', (url) => {
    expect(isApplicationUrl(url, DEV_ORIGIN)).toBe(false);
  });
});

describe('isSafeExternalUrl', () => {
  it('accepts https links', () => {
    expect(isSafeExternalUrl('https://example.com/docs')).toBe(true);
  });

  it.each(['http://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'smb://share/x'])(
    'rejects %s',
    (url) => {
      expect(isSafeExternalUrl(url)).toBe(false);
    },
  );
});

interface FakeWebContents extends GuardedWebContents {
  readonly openWindow: (url: string) => { action: 'deny' };
  readonly navigateTo: (url: string) => { prevented: boolean };
}

const createFakeWebContents = (): FakeWebContents => {
  let windowOpenHandler: ((details: { readonly url: string }) => { action: 'deny' }) | null = null;
  let navigationListener: ((event: { preventDefault: () => void }, url: string) => void) | null =
    null;

  return {
    setWindowOpenHandler(handler): void {
      windowOpenHandler = handler;
    },
    on(_event, listener): unknown {
      navigationListener = listener;
      return undefined;
    },
    openWindow(url): { action: 'deny' } {
      if (windowOpenHandler === null) {
        throw new Error('No window open handler registered.');
      }
      return windowOpenHandler({ url });
    },
    navigateTo(url): { prevented: boolean } {
      if (navigationListener === null) {
        throw new Error('No navigation listener registered.');
      }
      let prevented = false;
      navigationListener(
        {
          preventDefault: (): void => {
            prevented = true;
          },
        },
        url,
      );
      return { prevented };
    },
  };
};

describe('applyWebContentsSecurityPolicies', () => {
  it('never lets the application open a child window', () => {
    const contents = createFakeWebContents();
    const openExternal = vi.fn();
    applyWebContentsSecurityPolicies(contents, { devServerOrigin: null, openExternal });

    expect(contents.openWindow('https://example.com')).toEqual({ action: 'deny' });
    expect(contents.openWindow('https://example.com')).not.toEqual({ action: 'allow' });
  });

  it('sends safe external links to the default browser instead', () => {
    const contents = createFakeWebContents();
    const openExternal = vi.fn();
    applyWebContentsSecurityPolicies(contents, { devServerOrigin: null, openExternal });

    contents.openWindow('https://example.com/help');

    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/help');
  });

  it('does not hand unsafe schemes to the operating system', () => {
    const contents = createFakeWebContents();
    const openExternal = vi.fn();
    applyWebContentsSecurityPolicies(contents, { devServerOrigin: null, openExternal });

    contents.openWindow('file:///etc/passwd');

    expect(openExternal).not.toHaveBeenCalled();
  });

  it('allows navigation inside the application', () => {
    const contents = createFakeWebContents();
    const openExternal = vi.fn();
    applyWebContentsSecurityPolicies(contents, { devServerOrigin: DEV_ORIGIN, openExternal });

    expect(contents.navigateTo(`${DEV_ORIGIN}/index.html`).prevented).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('blocks navigation away from the application', () => {
    const contents = createFakeWebContents();
    const openExternal = vi.fn();
    applyWebContentsSecurityPolicies(contents, { devServerOrigin: null, openExternal });

    expect(contents.navigateTo('https://example.com').prevented).toBe(true);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com');
  });
});
