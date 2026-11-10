/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_REDUCE_MOTION, REDUCE_MOTION_VALUES } from '@core/persistence/motion';

import { THEME_ATTRIBUTE } from './applyAppearance';
import { MOTION_ATTRIBUTE, applyMotion } from './applyMotion';

/*
 * The entry point renders the application; this file is about the two
 * lines before that, so React is stubbed out. `applyAppearance.test.tsx`
 * is the one place that imports the entry point with React real, and one
 * such place is enough: two of them leave a scheduler callback running
 * after its jsdom environment has been torn down.
 */
vi.mock('react-dom/client', () => ({
  createRoot: (): { render: () => void; unmount: () => void } => ({
    render: (): void => undefined,
    unmount: (): void => undefined,
  }),
}));

/**
 * The renderer's share of ADR-032's reduced-motion contract.
 *
 * jsdom plays no animation and resolves no media query, so whether motion
 * actually stops is proved by the stylesheet tests in
 * `tests/unit/styles/motion.test.ts` and by the runtime verification in a
 * real Electron renderer. What can be proved here is the behaviour of the
 * one function that writes the attribute those rules key off.
 */

describe('applying a motion preference', () => {
  it('writes the resolved state, not the preference', () => {
    const root = document.createElement('html');

    applyMotion(root, 'always');

    // The cascade's vocabulary, not the settings surface's: `global.css`
    // disables motion for `reduced`, and would silently do nothing for a
    // root that said `always`.
    expect(root.getAttribute(MOTION_ATTRIBUTE)).toBe('reduced');
  });

  it('leaves the system to answer for itself', () => {
    const root = document.createElement('html');

    applyMotion(root, 'system');

    expect(root.getAttribute(MOTION_ATTRIBUTE)).toBe('system');
  });

  it.each(REDUCE_MOTION_VALUES)('writes something the stylesheet reads for %s', (preference) => {
    const root = document.createElement('html');

    applyMotion(root, preference);

    expect(['system', 'reduced']).toContain(root.getAttribute(MOTION_ATTRIBUTE));
  });

  it('replaces a previous state rather than accumulating', () => {
    const root = document.createElement('html');

    applyMotion(root, 'always');
    applyMotion(root, 'system');

    expect(root.getAttribute(MOTION_ATTRIBUTE)).toBe('system');
    expect(root.attributes).toHaveLength(1);
  });

  it('changes nothing else about the element, the appearance included', () => {
    const root = document.createElement('html');

    root.setAttribute('lang', 'en');
    root.setAttribute(THEME_ATTRIBUTE, 'dark');
    applyMotion(root, 'always');

    expect(root.getAttribute('lang')).toBe('en');
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe('dark');
  });

  it('uses the attribute the stylesheet keys off', () => {
    expect(MOTION_ATTRIBUTE).toBe('data-motion');
    expect(MOTION_ATTRIBUTE).not.toBe(THEME_ATTRIBUTE);
  });
});

describe('the renderer entry point', () => {
  it('applies the shared default before anything renders', async () => {
    // Deliberately wrong to start with: if the entry point did not write
    // the attribute, this value would survive and the expectation below
    // would fail.
    document.documentElement.setAttribute(MOTION_ATTRIBUTE, 'reduced');
    document.body.innerHTML = '<div id="root"></div>';

    await import('../main');

    expect(document.documentElement.getAttribute(MOTION_ATTRIBUTE)).toBe('system');
    expect(DEFAULT_REDUCE_MOTION).toBe('system');
  });
});
