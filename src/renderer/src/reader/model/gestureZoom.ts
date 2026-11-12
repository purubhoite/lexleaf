import { MAX_SCALE, MIN_SCALE } from './zoom';

/**
 * Zooming by gesture: a pinch on a trackpad, or the wheel with Ctrl held.
 *
 * Chromium reports both the same way — a wheel event with `ctrlKey` set —
 * and they differ only in size: a pinch arrives as a stream of small
 * movements, a mouse wheel as one large notch. Each movement multiplies
 * the zoom, so that the same gesture feels the same at 50 % and at 300 %.
 */

/** How much one unit of wheel movement changes the zoom. */
const SENSITIVITY = 0.01;

/**
 * The most one event may count for. A pinch never reaches it; a mouse
 * wheel's notch (100 or more) always does, which makes one notch a step
 * of about 16 % rather than a leap.
 */
const LARGEST_MOVEMENT = 15;

/** Pixels per line, for wheels that report lines rather than pixels. */
const LINE_HEIGHT = 16;

export interface WheelMovement {
  readonly deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (`WheelEvent.deltaMode`). */
  readonly deltaMode: number;
}

/** The factor one wheel movement multiplies the zoom by. */
export const gestureFactor = (movement: WheelMovement): number => {
  const pixels = movement.deltaMode === 0 ? movement.deltaY : movement.deltaY * LINE_HEIGHT;

  if (!Number.isFinite(pixels)) {
    return 1;
  }

  const bounded = Math.min(Math.max(pixels, -LARGEST_MOVEMENT), LARGEST_MOVEMENT);

  // Away from the reader (negative) zooms in, as it does everywhere else.
  return Math.exp(-bounded * SENSITIVITY);
};

/** A scale after a gesture: within the limits, to the nearest whole per cent. */
export const gestureScale = (scale: number, factor: number): number => {
  const next = Math.round(scale * factor * 100) / 100;

  return Math.min(Math.max(next, MIN_SCALE), MAX_SCALE);
};
