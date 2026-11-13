import { describe, expect, it } from 'vitest';

import { gestureFactor, gestureScale, wheelNotchSteps } from './gestureZoom';
import { MAX_SCALE, MIN_SCALE } from './zoom';

describe('zooming by gesture', () => {
  it('zooms in when the movement is away from the reader, and out towards them', () => {
    expect(gestureFactor({ deltaY: -4, deltaMode: 0 })).toBeGreaterThan(1);
    expect(gestureFactor({ deltaY: 4, deltaMode: 0 })).toBeLessThan(1);
    expect(gestureFactor({ deltaY: 0, deltaMode: 0 })).toBe(1);
  });

  it('moves a little for a pinch and a bounded step for a wheel notch', () => {
    const pinch = gestureFactor({ deltaY: -2, deltaMode: 0 });
    const notch = gestureFactor({ deltaY: -100, deltaMode: 0 });
    const hugeNotch = gestureFactor({ deltaY: -1200, deltaMode: 0 });

    expect(pinch).toBeCloseTo(1.02, 2);
    expect(notch).toBeCloseTo(1.16, 2);
    expect(hugeNotch).toBe(notch);
  });

  it('counts a notch of a mouse wheel as one per cent, and a pinch as none', () => {
    expect(wheelNotchSteps({ deltaY: -100, deltaMode: 0 })).toBe(1);
    expect(wheelNotchSteps({ deltaY: 120, deltaMode: 0 })).toBe(-1);
    expect(wheelNotchSteps({ deltaY: -1200, deltaMode: 0 })).toBe(1);
    expect(wheelNotchSteps({ deltaY: -3, deltaMode: 1 })).toBe(1);
    expect(wheelNotchSteps({ deltaY: -6, deltaMode: 0 })).toBe(0);
    expect(wheelNotchSteps({ deltaY: Number.NaN, deltaMode: 0 })).toBe(0);
  });

  it('adds the notches to the scale one per cent each', () => {
    expect(gestureScale(0.87, 1, 1)).toBe(0.88);
    expect(gestureScale(0.87, 1, -3)).toBe(0.84);
    expect(gestureScale(MAX_SCALE, 1, 2)).toBe(MAX_SCALE);
  });

  it('undoes itself: the same movement out and back returns to where it began', () => {
    const out = gestureFactor({ deltaY: 7, deltaMode: 0 });
    const back = gestureFactor({ deltaY: -7, deltaMode: 0 });

    expect(out * back).toBeCloseTo(1, 10);
  });

  it('reads a wheel that reports lines as the same kind of step', () => {
    expect(gestureFactor({ deltaY: -3, deltaMode: 1 })).toBe(
      gestureFactor({ deltaY: -100, deltaMode: 0 }),
    );
  });

  it('ignores a movement that is not a number', () => {
    expect(gestureFactor({ deltaY: Number.NaN, deltaMode: 0 })).toBe(1);
  });

  it('lands on whole per cents and stays inside the limits', () => {
    expect(gestureScale(1, 1.0234)).toBe(1.02);
    expect(gestureScale(MAX_SCALE, 1.5)).toBe(MAX_SCALE);
    expect(gestureScale(MIN_SCALE, 0.5)).toBe(MIN_SCALE);
  });
});
