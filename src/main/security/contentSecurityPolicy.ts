/**
 * Content Security Policy applied to every response the application loads.
 *
 * The production policy is deliberately restrictive: no remote code, no remote
 * connections, no framing. The development policy only widens what the Vite
 * dev server genuinely needs (its module/HMR endpoints and injected styles).
 */

const PRODUCTION_DIRECTIVES: readonly string[] = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
];

const toWebSocketOrigin = (httpOrigin: string): string => httpOrigin.replace(/^http/u, 'ws');

const developmentDirectives = (devServerOrigin: string): readonly string[] => {
  const socketOrigin = toWebSocketOrigin(devServerOrigin);

  return [
    "default-src 'none'",
    // 'unsafe-inline' is required in development only: Vite injects an inline
    // module preamble for React Fast Refresh, and blocking it leaves the
    // window blank. The production policy below must never allow it.
    `script-src 'self' 'unsafe-inline' ${devServerOrigin}`,
    `style-src 'self' 'unsafe-inline' ${devServerOrigin}`,
    `img-src 'self' data: ${devServerOrigin}`,
    `font-src 'self' data: ${devServerOrigin}`,
    `connect-src 'self' ${devServerOrigin} ${socketOrigin}`,
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ];
};

/**
 * Builds the CSP header value.
 *
 * @param devServerOrigin Origin of the Vite dev server, or `null` in production.
 */
export const buildContentSecurityPolicy = (devServerOrigin: string | null): string => {
  const directives =
    devServerOrigin === null || devServerOrigin === ''
      ? PRODUCTION_DIRECTIVES
      : developmentDirectives(devServerOrigin);

  return directives.join('; ');
};
