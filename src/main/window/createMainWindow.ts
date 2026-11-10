import { BrowserWindow, nativeTheme } from 'electron';

import type { Appearance } from '@core/persistence/appearance';

import { createSecureWebPreferences } from '../security/webPreferences';
import {
  createWindowTheme,
  resolveWindowBackground,
  type WindowThemeController,
} from '../theme/windowTheme';

const WINDOW_DEFAULTS = {
  width: 1200,
  height: 820,
  minWidth: 900,
  minHeight: 600,
} as const;

export interface MainWindowOptions {
  /** Absolute path to the compiled preload script. */
  readonly preloadPath: string;
  /** Absolute path to the packaged renderer entry document. */
  readonly rendererEntryPath: string;
  /** Dev server URL when running `npm run dev`, otherwise `null`. */
  readonly devServerUrl: string | null;
  /** Called once the window has painted and is visible. */
  readonly onReady: () => void;
  /** Called when the renderer document fails to load. */
  readonly onLoadFailure: (reason: string) => void;
  /**
   * What the window should look like (ADR-030): the stored `appearance`
   * preference, read before the window is created so the native surface is
   * never briefly the wrong colour (ADR-031, 6.8).
   */
  readonly appearance: Appearance;
}

/**
 * The window and the handle that keeps its colour right.
 *
 * The controller is returned rather than kept here because the appearance
 * can change while the application runs: the settings surface writes the
 * preference, the main process stores it, and whoever owns that flow calls
 * `apply`. One controller per window, and it stops with the window.
 */
export interface MainWindow {
  readonly window: BrowserWindow;
  readonly theme: WindowThemeController;
}

/**
 * Creates the single application window.
 *
 * The window is shown only once the renderer is ready to paint, which avoids
 * the white flash Electron otherwise produces on startup. Its background is
 * resolved *before* the window exists, from the appearance and — when that
 * is `system` — from Electron's own view of the operating system, so the
 * native surface is never briefly the wrong colour either (ADR-030).
 */
export const createMainWindow = async (options: MainWindowOptions): Promise<MainWindow> => {
  const window = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    backgroundColor: resolveWindowBackground(options.appearance, nativeTheme),
    show: false,
    webPreferences: createSecureWebPreferences(options.preloadPath),
  });

  /*
   * While the appearance follows the system, the window follows it too: the
   * renderer re-resolves its palette from CSS with no help, and this keeps
   * the native surface behind it in step. The subscription belongs to this
   * window and ends with it, and the controller replaces it rather than
   * adding to it when the preference changes (6.8).
   */
  const theme = createWindowTheme({ window, systemTheme: nativeTheme });

  theme.apply(options.appearance);

  window.once('ready-to-show', () => {
    window.show();
    options.onReady();
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    options.onLoadFailure(
      `${errorDescription} (${String(errorCode)}) while loading ${validatedURL}`,
    );
  });

  try {
    if (options.devServerUrl === null) {
      await window.loadFile(options.rendererEntryPath);
    } else {
      await window.loadURL(options.devServerUrl);
    }
  } catch (error: unknown) {
    options.onLoadFailure(error instanceof Error ? error.message : String(error));
  }

  return { window, theme };
};
