import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy } from './contentSecurityPolicy';

const parseDirectives = (policy: string): Map<string, string> =>
  new Map(
    policy.split('; ').map((directive) => {
      const [name, ...values] = directive.split(' ');
      return [name ?? '', values.join(' ')];
    }),
  );

describe('buildContentSecurityPolicy', () => {
  describe('production policy', () => {
    const directives = parseDirectives(buildContentSecurityPolicy(null));

    it('denies everything that is not explicitly allowed', () => {
      expect(directives.get('default-src')).toBe("'none'");
      expect(directives.get('object-src')).toBe("'none'");
      expect(directives.get('frame-src')).toBe("'none'");
    });

    it('allows only locally bundled code and assets', () => {
      expect(directives.get('script-src')).toBe("'self'");
      expect(directives.get('style-src')).toBe("'self'");
      expect(directives.get('connect-src')).toBe("'self'");
    });

    it('does not permit inline or evaluated script', () => {
      const policy = buildContentSecurityPolicy(null);

      expect(policy).not.toContain("'unsafe-inline'");
      expect(policy).not.toContain("'unsafe-eval'");
    });

    it('prevents the application from being framed or navigating forms away', () => {
      expect(directives.get('frame-ancestors')).toBe("'none'");
      expect(directives.get('form-action')).toBe("'none'");
      expect(directives.get('base-uri')).toBe("'none'");
    });
  });

  describe('development policy', () => {
    const devOrigin = 'http://localhost:5173';
    const directives = parseDirectives(buildContentSecurityPolicy(devOrigin));

    it('allows the dev server to serve modules', () => {
      expect(directives.get('script-src')).toBe(`'self' 'unsafe-inline' ${devOrigin}`);
    });

    // Regression: without 'unsafe-inline' Chromium blocks the inline React
    // Fast Refresh preamble injected by Vite and `npm run dev` renders a blank
    // window, while the production build keeps working.
    it("allows Vite's inline Fast Refresh preamble", () => {
      expect(directives.get('script-src')).toContain("'unsafe-inline'");
    });

    it('allows the hot-reload websocket connection', () => {
      expect(directives.get('connect-src')).toBe(`'self' ${devOrigin} ws://localhost:5173`);
    });

    it('still denies remote script by default', () => {
      expect(directives.get('default-src')).toBe("'none'");
      expect(buildContentSecurityPolicy(devOrigin)).not.toContain('https://');
    });
  });

  it('treats an empty dev server origin as production', () => {
    expect(buildContentSecurityPolicy('')).toBe(buildContentSecurityPolicy(null));
  });
});
