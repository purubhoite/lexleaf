import { describe, expect, it } from 'vitest';

import { createAppInfo } from './appInfo';

describe('createAppInfo', () => {
  it('passes through the runtime values', () => {
    expect(
      createAppInfo({
        name: 'Lexleaf',
        version: '0.1.0',
        electronVersion: '41.10.7',
        chromeVersion: '142.0.0.0',
      }),
    ).toEqual({
      name: 'Lexleaf',
      version: '0.1.0',
      electronVersion: '41.10.7',
      chromeVersion: '142.0.0.0',
    });
  });

  it('falls back to a readable placeholder when a runtime version is missing', () => {
    const info = createAppInfo({
      name: 'Lexleaf',
      version: '0.1.0',
      electronVersion: undefined,
      chromeVersion: '',
    });

    expect(info.electronVersion).toBe('unknown');
    expect(info.chromeVersion).toBe('unknown');
  });
});
