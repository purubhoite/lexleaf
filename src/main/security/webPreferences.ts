import type { WebPreferences } from 'electron';

/**
 * Security baseline required by docs/PRODUCT_SPEC.md section 17.
 *
 * Renderer content is treated as untrusted: it gets no Node.js integration, no
 * remote module, no `<webview>` tag, and reaches privileged functionality only
 * through the narrow preload bridge.
 */
export const createSecureWebPreferences = (preloadPath: string): WebPreferences => ({
  preload: preloadPath,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  spellcheck: false,
});
