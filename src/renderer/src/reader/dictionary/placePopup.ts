/**
 * Where the definition popup goes.
 *
 * A pure function over rectangles, because the rule has to be testable and
 * because jsdom has no layout. It never scrolls the document and never moves
 * the page: if the popup does not fit below the word it flips above, and if
 * it would leave the viewport sideways it shifts along it. The reader's
 * place in the document is not disturbed to make room for a popup.
 *
 * Milestone 6.3 made three changes, all of them inside this function:
 *
 * - **it never covers the word** (D2/W9, AC 12). The old `below` branch
 *   clamped the popup upwards to keep it inside the viewport, which could
 *   slide it over the very word it was defining. The popup now shrinks
 *   instead of climbing: the side is chosen first, the height is whatever
 *   that side has room for, and the top edge is derived from the anchor
 *   rather than from the viewport;
 * - **it says where the arrow points** (D1/W8, AC 13). `arrowLeft` is an
 *   offset from the popup's own left edge, or `null` when the word and the
 *   popup do not meaningfully overlap horizontally — there is nothing to
 *   point at from inside the popup, and an arrow at the corner would point
 *   at the wrong word;
 * - **it is honest about the first paint** (W11). Callers that have not
 *   measured yet pass `POPUP_MIN_HEIGHT`, not the viewport height, so the
 *   popup opens below the word and stays there once measured, instead of
 *   guessing it is viewport-tall, flipping above, and flipping back.
 */

export interface ViewportRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface PopupPlacement {
  readonly left: number;
  readonly top: number;
  readonly maxHeight: number;
  readonly placement: 'below' | 'above';
  /**
   * Where the arrow sits, measured from the popup's left edge, or `null`
   * when no arrow should be drawn.
   */
  readonly arrowLeft: number | null;
  /**
   * The post-condition this function exists to keep: the rectangle it
   * returns never intersects the anchor. It is a literal rather than a
   * computation because the branches below cannot produce an overlap —
   * `placePopup.test.ts` is what enforces it, over a generated grid of
   * anchors and viewports rather than over a handful of examples.
   */
  readonly coversAnchor: false;
}

/** Gap between the word and the popup, in CSS pixels. */
export const POPUP_GAP = 8;
/** Distance kept from the viewport edge. */
export const POPUP_MARGIN = 8;
export const POPUP_MAX_WIDTH = 360;
/** Share of the viewport height the popup may occupy. */
export const POPUP_MAX_HEIGHT_FRACTION = 0.45;
/**
 * The height assumed before the popup has been measured, and the smallest
 * height worth flipping sides for. A first paint at this height places the
 * popup below the word in every ordinary case, which is where it will stay.
 */
export const POPUP_MIN_HEIGHT = 96;
/**
 * How far the arrow stays from the popup's corners.
 *
 * It has to clear the rounded corner and half of the arrow's own rotated
 * width, or the arrow is drawn over the curve and looks detached:
 * `--radius-md` is 8px and `--popup-arrow-size` is 10px, whose rotated
 * half-width is 10 / sqrt(2) ≈ 7.07, so anything from about 15.1 upwards
 * works. The stylesheet test pins both tokens; this is the one number that
 * has to be kept in step with them by hand.
 */
export const POPUP_ARROW_INSET = 16;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

export const popupWidth = (viewport: ViewportSize): number =>
  Math.min(POPUP_MAX_WIDTH, Math.max(POPUP_MIN_HEIGHT, viewport.width - POPUP_MARGIN * 2));

/**
 * Where the arrow points, as an offset from the popup's left edge.
 *
 * `null` means "draw no arrow": either the word is off the side of the
 * popup entirely, or the only part of it the popup overlaps is under a
 * rounded corner, where an arrow would be pointing at nothing in
 * particular. When an arrow *is* drawn it is always inside the word's own
 * horizontal span (AC 13), so it points at the word rather than near it.
 */
const arrowOffset = (anchor: ViewportRect, left: number, width: number): number | null => {
  const overlapStart = Math.max(left, anchor.left);
  const overlapEnd = Math.min(left + width, anchor.left + anchor.width);

  if (overlapEnd <= overlapStart) {
    return null;
  }

  const lowest = Math.max(POPUP_ARROW_INSET, overlapStart - left);
  const highest = Math.min(width - POPUP_ARROW_INSET, overlapEnd - left);

  if (highest < lowest) {
    return null;
  }

  return clamp(anchor.left + anchor.width / 2 - left, lowest, highest);
};

/**
 * @param anchor the word's rectangle in viewport coordinates
 * @param height the popup's natural content height, or `POPUP_MIN_HEIGHT`
 *   before it has been measured
 * @param viewport the visible area
 */
export const placePopup = (
  anchor: ViewportRect,
  height: number,
  viewport: ViewportSize,
): PopupPlacement => {
  const allowed = Math.max(
    POPUP_MIN_HEIGHT,
    Math.floor(viewport.height * POPUP_MAX_HEIGHT_FRACTION),
  );
  const wanted = Math.min(Math.max(0, height), allowed);

  const anchorBottom = anchor.top + anchor.height;
  const spaceBelow = viewport.height - anchorBottom - POPUP_GAP - POPUP_MARGIN;
  const spaceAbove = anchor.top - POPUP_GAP - POPUP_MARGIN;

  /*
   * Below by default. Above only when the popup does not fit below and
   * either fits above or simply has more room there — and in that last
   * case it is the height that gives way, never the no-overlap rule.
   */
  const above = wanted > spaceBelow && (wanted <= spaceAbove || spaceAbove > spaceBelow);
  const maxHeight = Math.max(0, Math.min(allowed, above ? spaceAbove : spaceBelow));
  const resolved = Math.min(wanted, maxHeight);

  /*
   * The top edge is derived from the word, so neither branch can reach
   * across it: below starts one gap under the word's bottom, above ends
   * one gap over its top. Because `resolved` is already limited to the
   * room on that side, staying off the word also keeps the popup inside
   * the viewport — nothing has to be clamped back afterwards, which is
   * exactly what used to cause the overlap.
   */
  const top = above ? anchor.top - POPUP_GAP - resolved : anchorBottom + POPUP_GAP;

  const width = popupWidth(viewport);
  const furthestLeft = Math.max(POPUP_MARGIN, viewport.width - width - POPUP_MARGIN);

  /*
   * The popup starts at the word's left edge, which is where it has always
   * started. A short word then creates a problem the arrow made visible:
   * at 50% zoom a word can be narrower than the corner inset, so its centre
   * sits inside the rounded corner and there is nowhere legal to put the
   * arrow — runtime verification of 6.3 found exactly that, an arrowless
   * popup next to a small word.
   *
   * So the popup is allowed to slide a few pixels sideways to make room
   * for its own arrow: far enough that the word's centre clears the inset
   * at both corners, and no further. A word wider than twice the inset —
   * every word at normal zoom — is already clear, and nothing moves.
   */
  const centre = anchor.left + anchor.width / 2;
  const left = clamp(
    clamp(anchor.left, centre + POPUP_ARROW_INSET - width, centre - POPUP_ARROW_INSET),
    POPUP_MARGIN,
    furthestLeft,
  );

  return {
    left,
    top,
    maxHeight,
    placement: above ? 'above' : 'below',
    arrowLeft: arrowOffset(anchor, left, width),
    coversAnchor: false,
  };
};
