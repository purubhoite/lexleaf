import { resolveMotion, type ReduceMotion } from '@core/persistence/motion';

/**
 * The renderer's whole share of ADR-032's reduced-motion contract.
 *
 * One attribute on the document element, written beside the appearance
 * attribute by the module next to this one, for the same reason: both are
 * values the cascade reads, and keeping the two writers side by side is
 * what stops a second mechanism for "tell the stylesheet something" from
 * growing somewhere else.
 *
 * What this module deliberately does not do:
 *
 * - call `window.matchMedia('(prefers-reduced-motion: reduce)')`. The
 *   operating system's half of the contract is answered by the media query
 *   in `global.css`, by the engine that owns the cascade. JavaScript asking
 *   the same question a second time is how the two answers start to
 *   disagree;
 * - decide anything about *which* animations exist. The attribute turns
 *   motion off wholesale; which four behaviours exist when it is off is a
 *   property of the stylesheet alone.
 */

/** The attribute `global.css` keys the reduced-motion override off. */
export const MOTION_ATTRIBUTE = 'data-motion';

/**
 * Writes the resolved motion state onto the document element.
 *
 * The element is a parameter rather than a reach for `document`, so the
 * behaviour is testable on any element and the module stays free of
 * ambient globals.
 */
export const applyMotion = (root: Element, preference: ReduceMotion): void => {
  root.setAttribute(MOTION_ATTRIBUTE, resolveMotion(preference));
};
