/**
 * Navigation rules for the application window.
 *
 * The window may only ever display the application's own renderer. Anything
 * else is either opened in the user's default browser (when it is a safe
 * external link) or refused.
 */

const APPLICATION_PROTOCOL = 'file:';
const SAFE_EXTERNAL_PROTOCOLS: readonly string[] = ['https:'];

const toUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/** True when the URL belongs to the application itself (bundle or dev server). */
export const isApplicationUrl = (targetUrl: string, devServerOrigin: string | null): boolean => {
  const url = toUrl(targetUrl);

  if (url === null) {
    return false;
  }

  if (url.protocol === APPLICATION_PROTOCOL) {
    return true;
  }

  if (devServerOrigin === null || devServerOrigin === '') {
    return false;
  }

  const devServer = toUrl(devServerOrigin);

  return devServer !== null && url.origin === devServer.origin;
};

/** True when the URL may be handed to the operating system's default browser. */
export const isSafeExternalUrl = (targetUrl: string): boolean => {
  const url = toUrl(targetUrl);

  return url !== null && SAFE_EXTERNAL_PROTOCOLS.includes(url.protocol);
};

/** Minimal structural view of the Electron `WebContents` API used here. */
export interface GuardedWebContents {
  setWindowOpenHandler(handler: (details: { readonly url: string }) => { action: 'deny' }): void;
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault: () => void }, url: string) => void,
  ): unknown;
}

export interface WebContentsSecurityOptions {
  /** Origin of the Vite dev server, or `null` in production. */
  readonly devServerOrigin: string | null;
  /** Hands a vetted URL to the operating system (normally `shell.openExternal`). */
  readonly openExternal: (url: string) => void;
}

/**
 * Denies in-window navigation away from the application and refuses to create
 * child windows; safe external links are delegated to the default browser.
 */
export const applyWebContentsSecurityPolicies = (
  contents: GuardedWebContents,
  { devServerOrigin, openExternal }: WebContentsSecurityOptions,
): void => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      openExternal(url);
    }

    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isApplicationUrl(url, devServerOrigin)) {
      return;
    }

    event.preventDefault();

    if (isSafeExternalUrl(url)) {
      openExternal(url);
    }
  });
};
