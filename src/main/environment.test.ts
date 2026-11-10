import { describe, expect, it } from 'vitest';

import { resolveDevServerOrigin } from './environment';

describe('resolveDevServerOrigin', () => {
  it('extracts the origin of the dev server URL', () => {
    expect(resolveDevServerOrigin('http://localhost:5173/index.html')).toBe(
      'http://localhost:5173',
    );
  });

  it('reports production when the variable is not set', () => {
    expect(resolveDevServerOrigin(undefined)).toBeNull();
    expect(resolveDevServerOrigin('')).toBeNull();
  });

  it('reports production when the value is not a URL', () => {
    expect(resolveDevServerOrigin('definitely-not-a-url')).toBeNull();
  });
});
