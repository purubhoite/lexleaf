import type { Appearance } from '@core/persistence/appearance';

/**
 * The renderer's whole share of the theme (ADR-030).
 *
 * One attribute on the document element. Every colour decision after that is
 * the cascade's: `tokens.css` holds the dark palette under `:root`, the light
 * palette under `:root[data-theme='light']`, and the light palette again
 * inside `@media (prefers-color-scheme: light)` for a root that says
 * `system`. An explicit choice therefore wins because the media query can
 * only reach a root that says `system`, not because any code compares them.
 *
 * What this module deliberately does not do:
 *
 * - call `window.matchMedia`. The media query is evaluated by the engine
 *   that owns the cascade, which cannot disagree with itself, and jsdom
 *   would need a shim for a decision CSS makes natively;
 * - poll, listen, or subscribe to anything. A system theme change re-runs
 *   the media query on its own;
 * - talk to the main process. The native window background is resolved
 *   there, from the same appearance value, with no message between them.
 */

/** The attribute `tokens.css` keys the palette off. */
export const THEME_ATTRIBUTE = 'data-theme';

/**
 * Writes the appearance onto the document element.
 *
 * The element is a parameter rather than a reach for `document`, so the
 * behaviour is testable on any element and the module stays free of ambient
 * globals.
 */
export const applyAppearance = (root: Element, appearance: Appearance): void => {
  root.setAttribute(THEME_ATTRIBUTE, appearance);
};
