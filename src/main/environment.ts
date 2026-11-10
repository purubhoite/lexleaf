/**
 * Runtime environment detection for the main process.
 *
 * `electron-vite` sets `ELECTRON_RENDERER_URL` while the renderer is served by
 * the Vite dev server. Its absence means the packaged renderer bundle is used.
 */
export const resolveDevServerOrigin = (rendererUrl: string | undefined): string | null => {
  if (rendererUrl === undefined || rendererUrl === '') {
    return null;
  }

  try {
    return new URL(rendererUrl).origin;
  } catch {
    return null;
  }
};
