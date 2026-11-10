import { describe, expect, it } from 'vitest';

import { createSecureWebPreferences } from './webPreferences';

describe('createSecureWebPreferences', () => {
  const preferences = createSecureWebPreferences('/app/out/preload/index.js');

  it('points at the supplied preload script', () => {
    expect(preferences.preload).toBe('/app/out/preload/index.js');
  });

  it('isolates the renderer from Node.js', () => {
    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.nodeIntegrationInWorker).toBe(false);
    expect(preferences.nodeIntegrationInSubFrames).toBe(false);
    expect(preferences.sandbox).toBe(true);
  });

  it('keeps browser protections and risky features disabled', () => {
    expect(preferences.webSecurity).toBe(true);
    expect(preferences.allowRunningInsecureContent).toBe(false);
    expect(preferences.experimentalFeatures).toBe(false);
    expect(preferences.webviewTag).toBe(false);
  });
});
