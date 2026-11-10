/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';

import { APPEARANCES, DEFAULT_APPEARANCE } from '@core/persistence/appearance';

import { THEME_ATTRIBUTE, applyAppearance } from './applyAppearance';

/**
 * The renderer's share of ADR-030: one attribute, and no media queries in
 * JavaScript.
 *
 * jsdom resolves no media query and computes no custom property, so what
 * the attribute *means* is proved by the stylesheet tests in
 * `tests/unit/styles/theme.test.ts` and by the runtime verification in a
 * real Electron renderer. What can be proved here is the behaviour of the
 * one function that writes it.
 */

describe('applying an appearance', () => {
  it.each(APPEARANCES)('writes %s onto the element', (appearance) => {
    const root = document.createElement('html');

    applyAppearance(root, appearance);

    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe(appearance);
  });

  it('replaces a previous appearance rather than accumulating', () => {
    const root = document.createElement('html');

    applyAppearance(root, 'dark');
    applyAppearance(root, 'light');
    applyAppearance(root, 'system');

    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe('system');
    expect(root.attributes).toHaveLength(1);
  });

  it('changes nothing else about the element', () => {
    const root = document.createElement('html');

    root.setAttribute('lang', 'en');
    root.className = 'something';
    applyAppearance(root, 'light');

    expect(root.getAttribute('lang')).toBe('en');
    expect(root.className).toBe('something');
  });

  it('uses the attribute the stylesheet keys off', () => {
    expect(THEME_ATTRIBUTE).toBe('data-theme');
  });
});

describe('the renderer entry point', () => {
  it('applies the shared default before anything renders', async () => {
    // Deliberately wrong to start with: if the entry point did not write the
    // attribute, this value would survive and the expectation would fail.
    document.documentElement.setAttribute(THEME_ATTRIBUTE, 'dark');
    document.body.innerHTML = '<div id="root"></div>';
    const container = document.getElementById('root');

    await import('../main');

    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe(DEFAULT_APPEARANCE);
    expect(DEFAULT_APPEARANCE).toBe('system');

    /*
     * Wait for the React root the entry point created to finish.
     *
     * This is the only place in the suite that imports the entry point
     * with React real (`applyMotion.test.tsx` stubs it out and says why),
     * so this is the only place that leaves a scheduler callback in
     * flight. React commits its first render from a macrotask; if the
     * file ends before that callback runs, Vitest has already torn the
     * jsdom environment down and the callback dies with
     * `ReferenceError: window is not defined` — an unhandled error that
     * fails the whole run while every test in it passed. It was observed
     * once in fourteen full-suite runs and never in thirty runs of this
     * file alone, which is what a teardown race looks like.
     *
     * The wait is on an observable signal, not a duration: React having
     * put something in the container means the commit happened. The
     * drain afterwards gives the effects that commit scheduled their own
     * turn, while the environment is still there to run them in.
     */
    await vi.waitFor(
      () => {
        expect(container?.hasChildNodes()).toBe(true);
      },
      // Generous because it bounds a wait that normally ends in
      // milliseconds, not because anything here is timing-sensitive: a
      // first React render on a contended two-core machine has been seen
      // to take most of a second, and a bound that a loaded machine can
      // reach would be the very fault this wait exists to remove.
      { timeout: 20_000, interval: 10 },
    );

    for (let turn = 0; turn < 3; turn += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
});
