import { MAX_SCALE, MIN_SCALE, stepZoom } from './zoom';

/**
 * Zooming by gesture: a pinch on a trackpad, or the wheel with Ctrl held.
 *
 * Chromium reports both the same way — a wheel event with `ctrlKey` set —
 * and they differ only in size: a pinch arrives as a stream of small
 * movements, a mouse wheel as one large notch. A pinch multiplies the
 * zoom, so that it follows the fingers the same way at 50 % and at 300 %;
 * a notch of the wheel moves it by exactly one per cent.
 */

/** How much one unit of wheel movement changes the zoom. */
const SENSITIVITY = 0.01;

/** The most one event of a pinch may count for. */
const LARGEST_MOVEMENT = 15;

/**
 * Where a movement stops being a pinch and is a notch of a mouse wheel.
 * A pinch arrives a few pixels at a time; a notch is 100 or more.
 */
const NOTCH_MOVEMENT = 40;

/** Pixels per line, for wheels that report lines rather than pixels. */
const LINE_HEIGHT = 16;

export interface WheelMovement {
  readonly deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (`WheelEvent.deltaMode`). */
  readonly deltaMode: number;
}

const pixelsOf = (movement: WheelMovement): number =>
  movement.deltaMode === 0 ? movement.deltaY : movement.deltaY * LINE_HEIGHT;

/**
 * Whole per cents a movement steps the zoom by: 1 or -1 for a notch of a
 * mouse wheel, 0 for a pinch, which is handled by `gestureFactor` instead.
 */
export const wheelNotchSteps = (movement: WheelMovement): number => {
  const pixels = pixelsOf(movement);

  if (!Number.isFinite(pixels) || Math.abs(pixels) < NOTCH_MOVEMENT) {
    return 0;
  }

  // Away from the reader (negative) zooms in, as it does everywhere else.
  return pixels < 0 ? 1 : -1;
};

/** The factor one movement of a pinch multiplies the zoom by. */
export const gestureFactor = (movement: WheelMovement): number => {
  const pixels = pixelsOf(movement);

  if (!Number.isFinite(pixels)) {
    return 1;
  }

  const bounded = Math.min(Math.max(pixels, -LARGEST_MOVEMENT), LARGEST_MOVEMENT);

  // Away from the reader (negative) zooms in, as it does everywhere else.
  return Math.exp(-bounded * SENSITIVITY);
};

/**
 * A scale after a gesture: within the limits, to the nearest whole per cent.
 *
 * @param steps whole per cents added by notches of a mouse wheel
 */
export const gestureScale = (scale: number, factor: number, steps = 0): number => {
  const next = Math.round(scale * factor * 100) / 100;

  return stepZoom(Math.min(Math.max(next, MIN_SCALE), MAX_SCALE), steps);
};
