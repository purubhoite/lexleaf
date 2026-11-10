import { describe, expect, it } from 'vitest';

import type { Appearance } from '@core/persistence/appearance';

import {
  WINDOW_BACKGROUND,
  createWindowTheme,
  resolveWindowBackground,
  watchSystemTheme,
  type SystemTheme,
  type ThemedWindow,
} from './windowTheme';

/**
 * The native window's side of ADR-030.
 *
 * Electron is not available in a unit test, and these are not tests of
 * Electron: they are tests of which colour is chosen, when the window is
 * repainted, and when the listener goes away. The two objects below stand in
 * for `nativeTheme` and a `BrowserWindow` with exactly the surface the module
 * uses, so a change to that surface breaks compilation rather than passing
 * quietly. The real objects are exercised in the runtime verification
 * recorded in docs/PDF_SPIKE_REPORT.md.
 */

interface FakeSystem extends SystemTheme {
  /** Pretends the operating system changed, as `nativeTheme` would. */
  change: (dark: boolean) => void;
  readonly listenerCount: () => number;
}

const fakeSystem = (dark: boolean): FakeSystem => {
  const listeners = new Set<() => void>();
  let currentlyDark = dark;

  return {
    get shouldUseDarkColors(): boolean {
      return currentlyDark;
    },
    on(_event: 'updated', listener: () => void): unknown {
      listeners.add(listener);
      return this;
    },
    removeListener(_event: 'updated', listener: () => void): unknown {
      listeners.delete(listener);
      return this;
    },
    change(next: boolean): void {
      currentlyDark = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    listenerCount: () => listeners.size,
  };
};

interface FakeWindow extends ThemedWindow {
  readonly painted: string[];
  close: () => void;
}

const fakeWindow = (): FakeWindow => {
  const painted: string[] = [];
  const closeListeners = new Set<() => void>();
  let destroyed = false;

  return {
    painted,
    setBackgroundColor: (colour: string): void => {
      painted.push(colour);
    },
    isDestroyed: (): boolean => destroyed,
    once(_event: 'closed', listener: () => void): unknown {
      closeListeners.add(listener);
      return this;
    },
    close: (): void => {
      destroyed = true;
      for (const listener of [...closeListeners]) {
        listener();
      }
    },
  };
};

describe('the colour a window is created with', () => {
  const cases: ReadonlyArray<readonly [Appearance, boolean, string]> = [
    ['system', true, WINDOW_BACKGROUND.dark],
    ['system', false, WINDOW_BACKGROUND.light],
    ['light', true, WINDOW_BACKGROUND.light],
    ['light', false, WINDOW_BACKGROUND.light],
    ['dark', true, WINDOW_BACKGROUND.dark],
    ['dark', false, WINDOW_BACKGROUND.dark],
  ];

  it.each(cases)('%s on a dark=%s system is %s', (appearance, dark, expected) => {
    expect(resolveWindowBackground(appearance, fakeSystem(dark))).toBe(expected);
  });

  it('offers a colour for both palettes and nothing else', () => {
    expect(Object.keys(WINDOW_BACKGROUND).sort()).toStrictEqual(['dark', 'light']);

    for (const colour of Object.values(WINDOW_BACKGROUND)) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('gives the two palettes different colours', () => {
    // A single colour for both would make the whole mechanism invisible.
    expect(WINDOW_BACKGROUND.dark).not.toBe(WINDOW_BACKGROUND.light);
  });
});

describe('following the system while the application runs', () => {
  it('repaints the window when the system theme changes', () => {
    const system = fakeSystem(true);
    const window = fakeWindow();

    watchSystemTheme({ window, appearance: 'system', systemTheme: system });
    expect(window.painted).toStrictEqual([]);

    system.change(false);
    system.change(true);

    expect(window.painted).toStrictEqual([WINDOW_BACKGROUND.light, WINDOW_BACKGROUND.dark]);
  });

  it('subscribes once per window', () => {
    const system = fakeSystem(true);

    watchSystemTheme({ window: fakeWindow(), appearance: 'system', systemTheme: system });

    expect(system.listenerCount()).toBe(1);

    watchSystemTheme({ window: fakeWindow(), appearance: 'system', systemTheme: system });

    expect(system.listenerCount()).toBe(2);
  });

  it('removes the listener when the window is closed', () => {
    const system = fakeSystem(true);
    const window = fakeWindow();

    watchSystemTheme({ window, appearance: 'system', systemTheme: system });
    window.close();

    expect(system.listenerCount()).toBe(0);

    system.change(false);

    expect(window.painted).toStrictEqual([]);
  });

  it('never repaints a window that is already gone', () => {
    const system = fakeSystem(true);
    const window = fakeWindow();
    const stop = watchSystemTheme({ window, appearance: 'system', systemTheme: system });

    // A change that arrives between destruction and cleanup: the guard, not
    // the cleanup, is what makes this safe.
    const destroyedWindow: ThemedWindow = { ...window, isDestroyed: () => true };
    const guarded = watchSystemTheme({
      window: destroyedWindow,
      appearance: 'system',
      systemTheme: system,
    });

    system.change(false);

    expect(window.painted).toStrictEqual([WINDOW_BACKGROUND.light]);

    stop();
    guarded();
    expect(system.listenerCount()).toBe(0);
  });

  it('can be stopped twice without removing someone else’s listener', () => {
    const system = fakeSystem(true);
    const first = watchSystemTheme({
      window: fakeWindow(),
      appearance: 'system',
      systemTheme: system,
    });

    watchSystemTheme({ window: fakeWindow(), appearance: 'system', systemTheme: system });

    first();
    first();

    expect(system.listenerCount()).toBe(1);
  });
});

describe('an appearance that never went through parseAppearance', () => {
  /**
   * The 6.6 audit reached this function with values the type forbids and
   * got `undefined` back, which Electron answers by creating the window in
   * its own default white — the flash of the wrong colour ADR-030 exists to
   * prevent. Nothing could reach it at the time: one caller, typed, passing
   * the default. 6.8 will pass a value read off disk, so the boundary is
   * defended here rather than left to be remembered later.
   *
   * The cast is the point of the test: it stands in for the untyped value a
   * stored preference, a newer build or a corrupt file can produce.
   */
  const hostile: ReadonlyArray<readonly [string, unknown]> = [
    ['an unknown string', 'midnight'],
    ['an empty string', ''],
    ['the right word in the wrong case', 'Light'],
    ['a value with whitespace around it', ' dark '],
    ['a misspelling', 'systen'],
    ['undefined', undefined],
    ['null', null],
    ['a number', 1],
    ['an object', { appearance: 'dark' }],
    ['an array', ['light']],
  ];

  it.each(hostile)('%s still resolves to a real colour', (_label, value) => {
    for (const dark of [true, false]) {
      const colour = resolveWindowBackground(value as Appearance, fakeSystem(dark));

      expect(colour).toBeDefined();
      expect(colour).toMatch(/^#[0-9a-f]{6}$/);
      expect(Object.values(WINDOW_BACKGROUND)).toContain(colour);
    }
  });

  it.each(hostile)('%s behaves as the default appearance does', (_label, value) => {
    // The default is `system`, so an unreadable value follows the system
    // rather than inventing a fourth behaviour of its own.
    for (const dark of [true, false]) {
      expect(resolveWindowBackground(value as Appearance, fakeSystem(dark))).toBe(
        resolveWindowBackground('system', fakeSystem(dark)),
      );
    }
  });

  it('follows the system afterwards, as the default would', () => {
    const system = fakeSystem(false);
    const window = fakeWindow();

    watchSystemTheme({ window, appearance: 'midnight' as Appearance, systemTheme: system });

    expect(system.listenerCount()).toBe(1);

    system.change(true);

    expect(window.painted).toStrictEqual([WINDOW_BACKGROUND.dark]);
  });

  it('leaves the three valid appearances exactly as they were', () => {
    // The defence must be invisible to every value that is actually valid.
    const expected: ReadonlyArray<readonly [Appearance, boolean, string]> = [
      ['system', true, WINDOW_BACKGROUND.dark],
      ['system', false, WINDOW_BACKGROUND.light],
      ['light', true, WINDOW_BACKGROUND.light],
      ['light', false, WINDOW_BACKGROUND.light],
      ['dark', true, WINDOW_BACKGROUND.dark],
      ['dark', false, WINDOW_BACKGROUND.dark],
    ];

    for (const [appearance, dark, colour] of expected) {
      expect(resolveWindowBackground(appearance, fakeSystem(dark))).toBe(colour);
    }

    for (const appearance of ['light', 'dark'] as const) {
      const system = fakeSystem(true);

      watchSystemTheme({ window: fakeWindow(), appearance, systemTheme: system });

      expect(system.listenerCount()).toBe(0);
    }
  });
});

describe('an explicit appearance', () => {
  it.each(['light', 'dark'] as const)(
    '%s does not subscribe to the system at all',
    (appearance) => {
      const system = fakeSystem(true);
      const window = fakeWindow();

      watchSystemTheme({ window, appearance, systemTheme: system });

      expect(system.listenerCount()).toBe(0);
    },
  );

  it('is not repainted when the system changes under it', () => {
    const system = fakeSystem(true);
    const window = fakeWindow();

    watchSystemTheme({ window, appearance: 'light', systemTheme: system });
    system.change(false);
    system.change(true);

    expect(window.painted).toStrictEqual([]);
    expect(resolveWindowBackground('light', system)).toBe(WINDOW_BACKGROUND.light);
  });
});

/**
 * The controller a window keeps for its whole life (6.8).
 *
 * 6.6 only had to answer "what colour is this window created with".
 * Settings made the appearance changeable while the application runs, and
 * these are the properties that have to hold once it can change: the
 * native surface follows, the subscription is replaced rather than added
 * to, and everything stops when the window does.
 */
describe('changing a window’s appearance while it runs', () => {
  it('repaints the window when the preference changes', () => {
    const window = fakeWindow();
    const system = fakeSystem(false);
    const theme = createWindowTheme({ window, systemTheme: system });

    theme.apply('system');
    theme.apply('dark');
    theme.apply('light');

    expect(window.painted).toStrictEqual([
      WINDOW_BACKGROUND.light,
      WINDOW_BACKGROUND.dark,
      WINDOW_BACKGROUND.light,
    ]);
  });

  it('follows the system again after going back to system', () => {
    const window = fakeWindow();
    const system = fakeSystem(false);
    const theme = createWindowTheme({ window, systemTheme: system });

    theme.apply('dark');
    system.change(true);
    expect(window.painted).toStrictEqual([WINDOW_BACKGROUND.dark]);

    theme.apply('system');
    system.change(false);

    expect(window.painted).toStrictEqual([
      WINDOW_BACKGROUND.dark,
      WINDOW_BACKGROUND.dark,
      WINDOW_BACKGROUND.light,
    ]);
  });

  it('stops following the system when an explicit appearance is chosen', () => {
    const window = fakeWindow();
    const system = fakeSystem(true);
    const theme = createWindowTheme({ window, systemTheme: system });

    theme.apply('system');
    expect(system.listenerCount()).toBe(1);

    theme.apply('light');
    expect(system.listenerCount()).toBe(0);

    system.change(false);
    expect(window.painted).toStrictEqual([WINDOW_BACKGROUND.dark, WINDOW_BACKGROUND.light]);
  });

  it('never holds more than one subscription, however often it is changed', () => {
    const window = fakeWindow();
    const system = fakeSystem(false);
    const theme = createWindowTheme({ window, systemTheme: system });

    for (let index = 0; index < 20; index += 1) {
      theme.apply('system');
    }

    expect(system.listenerCount()).toBe(1);

    system.change(true);

    // One repaint for the change, not twenty.
    expect(window.painted.filter((colour) => colour === WINDOW_BACKGROUND.dark)).toHaveLength(1);
  });

  it('lets go of the system when the window closes', () => {
    const window = fakeWindow();
    const system = fakeSystem(false);
    const theme = createWindowTheme({ window, systemTheme: system });

    theme.apply('system');
    window.close();

    expect(system.listenerCount()).toBe(0);

    system.change(true);
    expect(window.painted).toStrictEqual([WINDOW_BACKGROUND.light]);
  });

  it('paints nothing once the window is gone', () => {
    const window = fakeWindow();
    const system = fakeSystem(false);
    const theme = createWindowTheme({ window, systemTheme: system });

    window.close();
    theme.apply('dark');

    expect(window.painted).toStrictEqual([]);
    expect(system.listenerCount()).toBe(0);
  });

  it('can be stopped twice', () => {
    const window = fakeWindow();
    const system = fakeSystem(false);
    const theme = createWindowTheme({ window, systemTheme: system });

    theme.apply('system');
    theme.stop();
    theme.stop();

    expect(system.listenerCount()).toBe(0);
  });
});
