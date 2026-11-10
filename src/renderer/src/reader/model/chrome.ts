/**
 * Chrome layout constants shared by the reader and its stylesheet.
 *
 * 6.4 gave the application its first media queries (W6). Two of them are
 * also decisions the view has to know about, because a media query cannot
 * set React state: at `SIDE_PANEL_BREAKPOINT` the reading-details panel
 * stops being affordable beside the document, so it starts collapsed
 * (CTL-8), and at `SEARCH_WRAP_BREAKPOINT` the search panel wraps instead
 * of pushing its own controls off-screen (CTL-7).
 *
 * The numbers live here, once, and `styles/reader.css` repeats them in its
 * `@media` conditions because CSS cannot read a custom property from a
 * media query. A test pins the two copies together: if one moves without
 * the other, the layout and the state would disagree about what "narrow"
 * means, and the panel would be collapsed in a window wide enough to show
 * it (or open in one that is not).
 */

/**
 * The window width, in CSS pixels, at or above which the reading-details
 * panel is worth a column of its own.
 */
export const SIDE_PANEL_BREAKPOINT = 1100;

/** The window width below which the search panel's controls wrap. */
export const SEARCH_WRAP_BREAKPOINT = 820;

/**
 * The narrowest window the application can be put into, from
 * `WINDOW_DEFAULTS.minWidth` in `main/window/createMainWindow`.
 *
 * It is repeated here because the stylesheet tests need to know which
 * widths are reachable: a rule that only releases its width below 820 px
 * never releases it in any window a reader can actually make, and must
 * not be mistaken for evidence that the supported layout fits. A test
 * pins this copy to the main process's value.
 */
export const MINIMUM_WINDOW_WIDTH = 900;

/**
 * The `max-width` that means "strictly narrower than `breakpoint`".
 *
 * `@media (max-width: 1100px)` matches *at* 1100, so a stylesheet written
 * that way disagrees with `width >= breakpoint` on exactly one pixel: the
 * 6.4 audit found the panel open at 1100 with the narrow single-column
 * layout underneath it, so it had no column to be open in (condition C1).
 *
 * The usual 0.02 px step is what browsers need rather than a smaller one:
 * widths are not integers under fractional zoom or scaling, and a step
 * below roughly a hundredth of a pixel is not reliably representable in
 * every engine's media-query arithmetic. The stylesheet calls this
 * function's result by hand — CSS cannot read a custom property in a
 * media condition — and `responsive.test.ts` recomputes it from the
 * constant and fails if the two ever disagree.
 */
export const belowBreakpoint = (breakpoint: number): string => `${String(breakpoint - 0.02)}px`;

/**
 * Whether the reading-details panel should start open.
 *
 * Read once, when the reader mounts. It is deliberately not a live
 * subscription: re-collapsing a panel the reader has just opened because
 * the window was nudged a pixel narrower would be the application arguing
 * with them. Within a session their choice wins, which is exactly what
 * CTL-8 asks for.
 *
 * The boundary is inclusive, and the stylesheet's `max-width` is written
 * from `belowBreakpoint` so that it is exclusive by exactly the same
 * pixel: at 1100 the panel both starts open and has a column; at 1099 it
 * neither starts open nor has one.
 */
export const sidePanelStartsOpen = (width: number): boolean => width >= SIDE_PANEL_BREAKPOINT;
