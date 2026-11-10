import { describe, expect, it } from 'vitest';

import {
  POPUP_ARROW_INSET,
  POPUP_GAP,
  POPUP_MARGIN,
  POPUP_MAX_WIDTH,
  POPUP_MIN_HEIGHT,
  placePopup,
  popupWidth,
  type ViewportRect,
  type ViewportSize,
} from './placePopup';

/**
 * Placement is a pure function so that the rules can be stated exactly;
 * jsdom has no layout, and "it looked right on my screen" is not a test.
 */

const viewport = { width: 1280, height: 900 };

const word = (overrides: Partial<ViewportRect> = {}): ViewportRect => ({
  left: 400,
  top: 300,
  width: 60,
  height: 18,
  ...overrides,
});

describe('placePopup', () => {
  it('sits below the word, left-aligned with it, with an eight pixel gap', () => {
    const placement = placePopup(word(), 200, viewport);

    expect(placement).toMatchObject({ placement: 'below', left: 400, top: 300 + 18 + POPUP_GAP });
  });

  it('flips above when the word is near the bottom and there is more room there', () => {
    const placement = placePopup(word({ top: 800 }), 300, viewport);

    expect(placement.placement).toBe('above');
    expect(placement.top).toBeLessThan(800 - POPUP_GAP);
    expect(placement.top).toBeGreaterThanOrEqual(POPUP_MARGIN);
  });

  it('stays below when the word is near the top, even if it must be short', () => {
    expect(placePopup(word({ top: 10 }), 600, viewport).placement).toBe('below');
  });

  it('never positions itself off the top of the viewport', () => {
    for (const top of [0, 5, 20, 100]) {
      expect(placePopup(word({ top }), 800, viewport).top).toBeGreaterThanOrEqual(0);
    }
  });

  it('shifts left so a word near the right edge does not push it off screen', () => {
    const placement = placePopup(word({ left: 1240 }), 200, viewport);

    expect(placement.left + popupWidth(viewport)).toBeLessThanOrEqual(viewport.width);
    expect(placement.left).toBeGreaterThanOrEqual(POPUP_MARGIN);
  });

  it('keeps a margin on the left for a word at the very edge', () => {
    expect(placePopup(word({ left: 0 }), 200, viewport).left).toBe(POPUP_MARGIN);
  });

  it('is never wider than its maximum, and narrows on a small viewport', () => {
    expect(popupWidth(viewport)).toBe(POPUP_MAX_WIDTH);
    expect(popupWidth({ width: 320, height: 480 })).toBe(320 - POPUP_MARGIN * 2);
  });

  it('never claims more than forty-five per cent of the viewport height', () => {
    for (const height of [480, 720, 900, 1440]) {
      const placement = placePopup(word({ top: 100 }), 10_000, { width: 1280, height });

      expect(placement.maxHeight).toBeLessThanOrEqual(Math.floor(height * 0.45));
    }
  });

  it('limits itself to the space on the side it chose', () => {
    const placement = placePopup(word({ top: 700, height: 18 }), 10_000, viewport);
    const used =
      placement.placement === 'below'
        ? placement.top + placement.maxHeight
        : 700 - placement.top - POPUP_GAP;

    expect(used).toBeLessThanOrEqual(viewport.height);
  });

  it('gives a usable height even in a viewport with almost no room', () => {
    const placement = placePopup(word({ top: 40, height: 18 }), 300, { width: 400, height: 120 });

    expect(placement.maxHeight).toBeGreaterThan(0);
    expect(placement.top).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic', () => {
    expect(placePopup(word(), 200, viewport)).toEqual(placePopup(word(), 200, viewport));
  });
});

/**
 * Milestone 6.3.
 *
 * The rule the popup exists to keep is "never cover the word", and a
 * handful of hand-picked rectangles is not evidence for a rule of that
 * shape: the old implementation passed every example above while still
 * covering the word in the case that mattered. So the invariant is checked
 * over a generated grid, and the arrow — which is only honest if it points
 * at the word — is checked the same way.
 */

/** The box the popup will actually occupy, not the box it may occupy. */
const popupRect = (
  anchor: ViewportRect,
  height: number,
  viewport: ViewportSize,
): ViewportRect & { arrowLeft: number | null; placement: string } => {
  const placement = placePopup(anchor, height, viewport);

  return {
    left: placement.left,
    top: placement.top,
    width: popupWidth(viewport),
    height: Math.min(height, placement.maxHeight),
    arrowLeft: placement.arrowLeft,
    placement: placement.placement,
  };
};

const intersects = (a: ViewportRect, b: ViewportRect): boolean =>
  a.left < b.left + b.width &&
  a.left + a.width > b.left &&
  a.top < b.top + b.height &&
  a.top + a.height > b.top;

/** Anchors and viewports chosen to cover every edge and both flips. */
const grid = (): Array<{ anchor: ViewportRect; height: number; viewport: ViewportSize }> => {
  const viewports: ViewportSize[] = [
    { width: 1280, height: 900 }, // ordinary desktop
    { width: 1920, height: 1080 },
    { width: 800, height: 600 }, // the minimum supported window
    { width: 640, height: 480 }, // narrower than the popup's maximum
    { width: 420, height: 320 }, // very small
  ];
  const heights = [POPUP_MIN_HEIGHT, 180, 420, 1200];
  const cases: Array<{ anchor: ViewportRect; height: number; viewport: ViewportSize }> = [];

  for (const viewport of viewports) {
    // Words at the top, bottom, left, right, corners and middle, plus a
    // word hanging off each edge as it does mid-scroll.
    const tops = [
      -10,
      0,
      4,
      40,
      Math.round(viewport.height / 2),
      viewport.height - 30,
      viewport.height - 2,
    ];
    const lefts = [
      -20,
      0,
      6,
      100,
      Math.round(viewport.width / 2),
      viewport.width - 40,
      // Overlapping the popup only under its rounded corner, which is the
      // case where an arrow would point beside the word rather than at it.
      viewport.width - 20,
      viewport.width - 4,
    ];

    for (const top of tops) {
      for (const left of lefts) {
        for (const height of heights) {
          cases.push({ anchor: { left, top, width: 64, height: 18 }, height, viewport });
        }
      }
    }
  }

  return cases;
};

describe('placePopup never covers the word (D2/W9, AC 12)', () => {
  it('covers 1120 anchor and viewport combinations', () => {
    expect(grid()).toHaveLength(1120);
  });

  it('returns a rectangle that does not intersect the anchor, in any of them', () => {
    const covering = grid().filter(({ anchor, height, viewport }) =>
      intersects(popupRect(anchor, height, viewport), anchor),
    );

    expect(covering).toEqual([]);
  });

  it('declares the post-condition it keeps', () => {
    for (const { anchor, height, viewport } of grid()) {
      expect(placePopup(anchor, height, viewport).coversAnchor).toBe(false);
    }
  });

  it('stays inside the viewport while doing it', () => {
    const escaping = grid().filter(({ anchor, height, viewport }) => {
      const rect = popupRect(anchor, height, viewport);

      // A word hanging off the edge can leave no room at all on either
      // side; what must never happen is the popup itself overflowing.
      return rect.top < 0 || rect.top + rect.height > viewport.height;
    });

    expect(escaping).toEqual([]);
  });

  it('shrinks rather than overlapping when neither side has room', () => {
    // 18px word in the middle of a 120px viewport: 47px above, 47px below.
    const viewport = { width: 400, height: 120 };
    const anchor = { left: 40, top: 51, width: 60, height: 18 };
    const placement = placePopup(anchor, 400, viewport);

    expect(placement.maxHeight).toBeLessThan(POPUP_MIN_HEIGHT);
    expect(placement.maxHeight).toBeGreaterThan(0);
    expect(intersects(popupRect(anchor, 400, viewport), anchor)).toBe(false);
  });

  it('is the case the previous implementation got wrong', () => {
    // Regression guard for W9. Before 6.3 this clamped the popup upwards
    // to keep it on screen and slid it over the word in the process.
    const viewport = { width: 400, height: 120 };
    const anchor = { left: 40, top: 40, width: 60, height: 18 };
    const placement = placePopup(anchor, 300, viewport);

    expect(placement.top).toBeGreaterThanOrEqual(anchor.top + anchor.height);
  });
});

describe('the arrow points at the word (D1/W8, AC 13)', () => {
  const viewport = { width: 1280, height: 900 };

  it('sits at the centre of the word when the popup starts beneath it', () => {
    const placement = placePopup(word(), 200, viewport);

    // Popup left-aligns with the word, so the centre of a 60px word is 30.
    expect(placement.arrowLeft).toBe(30);
  });

  it('points inside the word in every case where it is drawn', () => {
    const outside = grid().filter(({ anchor, height, viewport: size }) => {
      const rect = popupRect(anchor, height, size);

      if (rect.arrowLeft === null) {
        return false;
      }

      const pointsAt = rect.left + rect.arrowLeft;

      return pointsAt < anchor.left || pointsAt > anchor.left + anchor.width;
    });

    expect(outside).toEqual([]);
  });

  it('never lands on a rounded corner', () => {
    const onCorner = grid().filter(({ anchor, height, viewport: size }) => {
      const rect = popupRect(anchor, height, size);

      return (
        rect.arrowLeft !== null &&
        (rect.arrowLeft < POPUP_ARROW_INSET || rect.arrowLeft > rect.width - POPUP_ARROW_INSET)
      );
    });

    expect(onCorner).toEqual([]);
  });

  it('is absent when the word is off the right of the popup entirely', () => {
    // A word scrolled almost out of the viewport: the popup cannot reach it.
    expect(placePopup(word({ left: 1279 }), 200, viewport).arrowLeft).toBeNull();
  });

  it('is absent when the word is off the left of the popup entirely', () => {
    expect(placePopup(word({ left: -70 }), 200, viewport).arrowLeft).toBeNull();
  });

  it('is present whenever the word and the popup meaningfully overlap', () => {
    // Walk a word across the right-hand edge one pixel at a time and check
    // the arrow disappears exactly once, and does not come back.
    const seen = [];

    for (let left = 1100; left <= 1279; left += 1) {
      seen.push(placePopup(word({ left }), 200, viewport).arrowLeft !== null);
    }

    const firstAbsent = seen.indexOf(false);

    expect(firstAbsent).toBeGreaterThan(0);
    expect(seen.slice(firstAbsent).some((present) => present)).toBe(false);
  });

  it('follows the word rather than the popup when the popup is pinned to the edge', () => {
    const near = placePopup(word({ left: 1000 }), 200, viewport);
    const nearer = placePopup(word({ left: 1060 }), 200, viewport);

    // Both popups are pinned at the same x, so only the arrow may move.
    expect(nearer.left).toBe(near.left);
    expect(nearer.arrowLeft).toBeGreaterThan(near.arrowLeft ?? 0);
  });
});

describe('the first paint is already in the right place (W11)', () => {
  const viewport = { width: 1280, height: 900 };

  it('assumes a short popup, not a viewport-tall one', () => {
    // The word sits 500px down a 900px viewport: 374px of room below, 484
    // above. A popup assumed to be viewport-tall fits in neither and goes
    // above; measured at 300 it belongs below. The estimate must agree
    // with the measurement, or the reader sees it move.
    const anchor = word({ top: 500 });

    expect(placePopup(anchor, POPUP_MIN_HEIGHT, viewport).placement).toBe('below');
    expect(placePopup(anchor, 300, viewport).placement).toBe('below');
    expect(placePopup(anchor, viewport.height, viewport).placement).toBe('above');
  });

  it('agrees with the measured placement for every ordinary word', () => {
    // Anywhere the popup genuinely fits below, the estimate and the real
    // height must choose the same side, so measurement never moves it.
    const disagreeing = [];

    for (let top = 0; top <= 400; top += 20) {
      const anchor = word({ top });
      const estimated = placePopup(anchor, POPUP_MIN_HEIGHT, viewport);
      const measured = placePopup(anchor, 360, viewport);

      if (estimated.placement !== measured.placement || estimated.left !== measured.left) {
        disagreeing.push(top);
      }
    }

    expect(disagreeing).toEqual([]);
  });
});

describe('readability constraints are unchanged (AC 15)', () => {
  it('is never wider than 360px, whatever the viewport', () => {
    for (const width of [320, 640, 800, 1280, 1920, 3840]) {
      expect(popupWidth({ width, height: 900 })).toBeLessThanOrEqual(POPUP_MAX_WIDTH);
    }
  });

  it('keeps a margin on both sides once the window is narrower than the maximum', () => {
    // Above 376px the 360px cap binds; below it, the margin does.
    expect(popupWidth({ width: 320, height: 600 })).toBe(320 - POPUP_MARGIN * 2);
    expect(popupWidth({ width: 360, height: 600 })).toBe(360 - POPUP_MARGIN * 2);
    expect(popupWidth({ width: 1280, height: 600 })).toBe(POPUP_MAX_WIDTH);
  });

  it('occupies no more than 45 per cent of the minimum supported window', () => {
    // 360px is exactly 45% of the 800px minimum window, which is why the
    // maximum is the number it is; wider windows only make it a smaller
    // share. A line is readable because it is short, not because it is a
    // fraction of something.
    const minimumWindow = { width: 800, height: 600 };

    expect(popupWidth(minimumWindow)).toBeLessThanOrEqual(minimumWindow.width * 0.45);

    for (const width of [800, 1024, 1280, 1920, 3840]) {
      expect(popupWidth({ width, height: 900 })).toBeLessThanOrEqual(width * 0.45);
    }
  });

  it('never takes more than 45 per cent of the viewport height', () => {
    const tall = grid().filter(
      ({ anchor, height, viewport }) =>
        placePopup(anchor, height, viewport).maxHeight > Math.floor(viewport.height * 0.45),
    );

    expect(tall).toEqual([]);
  });

  it('keeps the gap between the word and the popup on both sides', () => {
    const below = placePopup(word(), 200, { width: 1280, height: 900 });
    const above = placePopup(word({ top: 800 }), 300, { width: 1280, height: 900 });

    expect(below.top).toBe(300 + 18 + POPUP_GAP);
    expect(above.top + Math.min(300, above.maxHeight)).toBe(800 - POPUP_GAP);
  });
});

describe('a word narrower than the arrow inset still gets an arrow', () => {
  const viewport = { width: 1280, height: 900 };

  /*
   * Found by driving the real application at 50% zoom: a six-pixel word
   * left-aligned with the popup put its own centre inside the popup's
   * rounded corner, so there was no legal position for the arrow and none
   * was drawn. The popup now shifts far enough to make room for it.
   */
  it('shifts the popup just enough to clear the corner', () => {
    const tiny = { left: 400, top: 300, width: 6, height: 7 };
    const placement = placePopup(tiny, 200, viewport);

    expect(placement.arrowLeft).not.toBeNull();

    const pointsAt = placement.left + (placement.arrowLeft ?? 0);

    expect(pointsAt).toBeGreaterThanOrEqual(tiny.left);
    expect(pointsAt).toBeLessThanOrEqual(tiny.left + tiny.width);
    expect(placement.arrowLeft).toBeGreaterThanOrEqual(POPUP_ARROW_INSET);
  });

  it('shifts by the least it can', () => {
    const tiny = { left: 400, top: 300, width: 6, height: 7 };
    const centre = tiny.left + tiny.width / 2;

    // Exactly enough for the centre to sit on the inset, not a pixel more.
    expect(placePopup(tiny, 200, viewport).left).toBe(centre - POPUP_ARROW_INSET);
  });

  it('leaves an ordinary word where it was', () => {
    // Anything wider than twice the inset is already clear of both
    // corners, so this must not become a general re-alignment.
    for (const width of [POPUP_ARROW_INSET * 2, 60, 148, 300]) {
      const anchor = { left: 400, top: 300, width, height: 18 };

      expect(placePopup(anchor, 200, viewport).left).toBe(400);
    }
  });

  it('still refuses when the word is genuinely off the side', () => {
    expect(
      placePopup({ left: 1279, top: 300, width: 6, height: 7 }, 200, viewport).arrowLeft,
    ).toBeNull();
  });

  it('keeps every earlier guarantee while doing it', () => {
    const tiny = { left: 400, top: 300, width: 6, height: 7 };
    const rect = popupRect(tiny, 200, viewport);

    expect(intersects(rect, tiny)).toBe(false);
    expect(rect.left).toBeGreaterThanOrEqual(POPUP_MARGIN);
    expect(rect.left + rect.width).toBeLessThanOrEqual(viewport.width - POPUP_MARGIN);
  });
});
