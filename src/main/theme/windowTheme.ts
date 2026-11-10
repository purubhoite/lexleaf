import type { BrowserWindow, NativeTheme } from 'electron';

import {
  parseAppearance,
  resolveAppearance,
  type Appearance,
  type ResolvedTheme,
} from '@core/persistence/appearance';

/**
 * The native window's background colour (ADR-030).
 *
 * This exists because of one visible defect it prevents: the window is a
 * native surface that exists before the renderer has painted anything, so
 * whatever colour it was created with is what the reader sees first. A
 * window created dark in a light session flashes dark; a window that never
 * updates stays wrong for the rest of the session when the system changes.
 *
 * The renderer is not involved. It resolves its own palette from CSS, from
 * the same appearance value, and there is no message between the two
 * processes — ADR-030 explicitly refuses a new IPC channel for a colour.
 */

/**
 * The two window colours, which must equal `--colour-background` in each
 * palette of `styles/tokens.css`. Nothing checks that at runtime, because
 * the main process cannot read the renderer's stylesheet; the agreement is
 * enforced by `tests/unit/styles/theme.test.ts`, which reads both files.
 */
export const WINDOW_BACKGROUND: Readonly<Record<ResolvedTheme, string>> = {
  dark: '#11141a',
  light: '#eef1f6',
};

/** The part of Electron's `nativeTheme` this module uses. */
export interface SystemTheme {
  readonly shouldUseDarkColors: boolean;
  on: (event: 'updated', listener: () => void) => unknown;
  removeListener: (event: 'updated', listener: () => void) => unknown;
}

/** The part of a `BrowserWindow` this module uses. */
export interface ThemedWindow {
  setBackgroundColor: (colour: string) => void;
  isDestroyed: () => boolean;
  once: (event: 'closed', listener: () => void) => unknown;
}

/**
 * The colour a window should be created with, or repainted to.
 *
 * `system` is answered by Electron's own view of the operating system. An
 * explicit appearance ignores it.
 *
 * The value is parsed here even though the parameter is typed, because a
 * type is not a guarantee at a process boundary: the appearance will come
 * from a stored preference once 6.8 writes one, and a value that never went
 * through `parseAppearance` would otherwise index this table with a key it
 * does not have, return `undefined`, and leave Electron to create the window
 * in its own default white — the flash this module exists to prevent. An
 * unreadable value therefore means what it means everywhere else in the
 * application: the default, `system` (ADR-031). No new state, and nothing
 * changes for the three valid ones.
 */
export const resolveWindowBackground = (
  appearance: Appearance,
  systemTheme: Pick<SystemTheme, 'shouldUseDarkColors'>,
): string =>
  WINDOW_BACKGROUND[
    resolveAppearance(parseAppearance(appearance), systemTheme.shouldUseDarkColors)
  ];

export interface WindowThemeOptions {
  readonly window: ThemedWindow;
  readonly appearance: Appearance;
  readonly systemTheme: SystemTheme;
  /**
   * Whether to stop when the window closes. True for a caller that
   * subscribes once; the 6.8 controller below passes `false` because it
   * registers one close handler of its own and may subscribe again every
   * time the preference changes — one handler per window, not one per
   * change (6.6's rule, kept while the appearance became mutable).
   */
  readonly stopOnClose?: boolean;
}

/**
 * Keeps one window's background in step with the system theme.
 *
 * Only `system` subscribes: an explicit appearance has nothing to follow, so
 * attaching a listener that would immediately decide to do nothing would be
 * a listener leak with extra steps. The subscription is registered once per
 * window and removed when that window is closed, so a second window cannot
 * inherit the first one's listener and a closed window cannot be repainted.
 *
 * Returns the function that stops it, for a caller that wants to stop it
 * sooner; closing the window does the same thing.
 */
export const watchSystemTheme = ({
  window,
  appearance,
  systemTheme,
  stopOnClose = true,
}: WindowThemeOptions): (() => void) => {
  // Parsed for the same reason as above, and in the same way, so that an
  // unreadable value cannot resolve as the default in one half of this
  // module and as something else in the other: a window whose colour
  // follows the system would otherwise never be told the system changed.
  const resolved = parseAppearance(appearance);

  if (resolved !== 'system') {
    return () => undefined;
  }

  const update = (): void => {
    if (window.isDestroyed()) {
      return;
    }

    window.setBackgroundColor(resolveWindowBackground(resolved, systemTheme));
  };

  systemTheme.on('updated', update);

  let stopped = false;
  const stop = (): void => {
    if (stopped) {
      return;
    }

    stopped = true;
    systemTheme.removeListener('updated', update);
  };

  if (stopOnClose) {
    window.once('closed', stop);
  }

  return stop;
};

/**
 * One window's appearance over its whole life (ADR-030, ADR-031).
 *
 * `watchSystemTheme` above answers the startup question — what colour is
 * this window created with, and does it follow the system — and that was
 * the whole of 6.6, because nothing could change the appearance while the
 * application ran. 6.8 adds the settings surface, so the answer can now
 * change: a reader who picks `dark` while the system is light must see the
 * native surface change with the chrome, and a reader who goes back to
 * `system` must start following it again.
 *
 * That is all this controller does. It is not a second theme mechanism:
 * the colour still comes from `resolveWindowBackground`, the subscription
 * is still `watchSystemTheme`, and the renderer still resolves its own
 * palette from CSS with no message from here. What the controller owns is
 * the *replacement* — the previous subscription is stopped before the next
 * one is made, so a window never ends up with two listeners however many
 * times the preference is changed, and the last one is removed when the
 * window closes.
 *
 * It is deliberately told an appearance rather than asked for one: the
 * stored preference is read by the caller, so this module keeps knowing
 * nothing about files, IPC or where a preference comes from.
 */
export interface WindowThemeController {
  /** Repaints the native surface and re-subscribes to match `appearance`. */
  apply: (appearance: Appearance) => void;
  /** Stops following the system. Closing the window does this too. */
  stop: () => void;
}

export interface WindowThemeControllerOptions {
  readonly window: ThemedWindow;
  readonly systemTheme: SystemTheme;
}

export const createWindowTheme = ({
  window,
  systemTheme,
}: WindowThemeControllerOptions): WindowThemeController => {
  let unsubscribe: (() => void) | null = null;

  const stop = (): void => {
    unsubscribe?.();
    unsubscribe = null;
  };

  window.once('closed', stop);

  return {
    apply: (appearance: Appearance): void => {
      stop();

      if (window.isDestroyed()) {
        return;
      }

      window.setBackgroundColor(resolveWindowBackground(appearance, systemTheme));
      unsubscribe = watchSystemTheme({ window, appearance, systemTheme, stopOnClose: false });
    },
    stop,
  };
};

/** Narrows Electron's own objects to what this module needs. */
export const asSystemTheme = (nativeTheme: NativeTheme): SystemTheme => nativeTheme;

export const asThemedWindow = (window: BrowserWindow): ThemedWindow => window;
