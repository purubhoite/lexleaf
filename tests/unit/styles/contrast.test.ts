/**
 * Contrast tests for the palettes (ADR-029, Milestone 6.1; ADR-030, 6.6).
 *
 * The ratios are computed from the values actually declared in tokens.css, so
 * a palette change that makes text unreadable fails here rather than in a
 * screenshot nobody takes. Thresholds are WCAG 2.2: 4.5:1 for body text
 * (1.4.3) and 3:1 for the boundary of a control or a focus indicator
 * (1.4.11).
 *
 * Every case runs over **both** appearances. 6.6 doubled the colour surface,
 * and the whole point of arithmetic here is that the second palette is held
 * to the first one's standard without anyone having to look at it.
 *
 * The document surface is excluded by design — the PDF renders in its own
 * colours and the application must not repaint it — with one exception that
 * is not about repainting: the page's own edge has to stay visible against
 * whatever the application puts behind it, in both appearances.
 */

import { describe, expect, it } from 'vitest';

import { contrastRatio, paletteValue, type Palette } from './stylesheetSource';

/** The appearances a reader can actually be looking at. */
const APPEARANCES: readonly Palette[] = ['dark', 'light'];

const colour = (token: string, palette: Palette): string => {
  const value = paletteValue(token, palette);

  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(
      `${token} is expected to be a six-digit hex colour, not ${value} (${palette}).`,
    );
  }

  return value;
};

/** Every opaque surface a piece of chrome can sit on, in one appearance. */
const surfaces = (palette: Palette): ReadonlyArray<readonly [string, string]> => [
  ['background', colour('--colour-background', palette)],
  ['surface', colour('--colour-surface', palette)],
  ['raised surface', colour('--colour-surface-raised', palette)],
  ['scroller', colour('--colour-scroller', palette)],
  ['control fill', colour('--colour-control', palette)],
];

/** The paper the PDF is drawn on: white in both appearances, by ADR-030. */
const PAGE = '#ffffff';

/** The hairline `.page` draws around itself (reader.css, document surface). */
const PAGE_EDGE = '#2b323e';

describe.each(APPEARANCES)('%s appearance', (palette) => {
  const EVERY_SURFACE = surfaces(palette);
  const CONTROL = colour('--colour-control', palette);

  describe('text contrast (WCAG 2.2 1.4.3, 4.5:1)', () => {
    const TEXT_TOKENS = ['--colour-text', '--colour-text-muted', '--colour-problem'] as const;

    for (const token of TEXT_TOKENS) {
      for (const [name, surface] of EVERY_SURFACE) {
        it(`${token} on the ${name} is readable`, () => {
          expect(contrastRatio(colour(token, palette), surface)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }

    it('failure text is readable on the surfaces that report failures', () => {
      // The previous #b3261e measured 2.53:1 on the dark popup surface (W2/W3).
      for (const [, surface] of EVERY_SURFACE) {
        expect(contrastRatio(colour('--colour-danger', palette), surface)).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    });
  });

  describe('non-text contrast (WCAG 2.2 1.4.11, 3:1)', () => {
    it('a control boundary is visible against its own fill and its surface', () => {
      const border = colour('--colour-border-strong', palette);

      expect(contrastRatio(border, CONTROL)).toBeGreaterThanOrEqual(3);

      for (const [, surface] of EVERY_SURFACE) {
        expect(contrastRatio(border, surface)).toBeGreaterThanOrEqual(3);
      }
    });

    it('the focus ring is visible on every chrome surface', () => {
      const focus = colour('--colour-focus', palette);

      for (const [, surface] of EVERY_SURFACE) {
        expect(contrastRatio(focus, surface)).toBeGreaterThanOrEqual(3);
      }
    });

    it('the accent is visible wherever it marks state', () => {
      // `.dictionary-popup__saved` carries the accent as its border.
      expect(
        contrastRatio(colour('--colour-accent', palette), colour('--colour-surface', palette)),
      ).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(colour('--colour-accent', palette), CONTROL)).toBeGreaterThanOrEqual(3);
    });

    it('the pressed library toggle is distinguishable from an unpressed one', () => {
      // `.shell__library-toggle[aria-pressed='true']` swaps the border colour.
      const pressed = colour('--colour-problem', palette);

      expect(contrastRatio(pressed, CONTROL)).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(pressed, colour('--colour-border-strong', palette)),
      ).toBeGreaterThanOrEqual(1.5);
    });

    it('the hover fill is a visible change, not a repaint', () => {
      const hover = contrastRatio(colour('--colour-control-hover', palette), CONTROL);

      expect(hover).toBeGreaterThan(1);
      expect(hover).toBeLessThan(2);
    });
  });

  describe('the document surface keeps its own contrast', () => {
    it('shows where the page ends', () => {
      // In the dark appearance the white page is its own boundary; in the
      // light one the surfaces around it are nearly as bright, so the
      // page's hairline is what makes the edge visible. One of the two has
      // to clear 3:1, in both appearances (WCAG 2.2 1.4.11).
      const scroller = colour('--colour-scroller', palette);
      const edge = Math.max(
        contrastRatio(PAGE, scroller),
        Math.min(contrastRatio(PAGE_EDGE, scroller), contrastRatio(PAGE_EDGE, PAGE)),
      );

      expect(edge).toBeGreaterThanOrEqual(3);
    });

    it('keeps the failure overlay readable on its own panel', () => {
      // The overlay's panel and text are literals inside the document
      // surface precisely so that neither appearance can dim them.
      expect(contrastRatio('#e8ecf2', '#11141a')).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio('#e8b45a', '#11141a')).toBeGreaterThanOrEqual(4.5);
    });
  });
});

describe('the page against the application behind it', () => {
  it('is unmistakable in the dark appearance', () => {
    expect(contrastRatio(PAGE, colour('--colour-background', 'dark'))).toBeGreaterThanOrEqual(4.5);
  });

  it('is a sheet on a surface in the light appearance, not a hole in one', () => {
    // Deliberately *not* a 4.5:1 claim: a light application behind white
    // paper is the correct look, and the edge test above is what proves the
    // page is still distinguishable.
    const ratio = contrastRatio(PAGE, colour('--colour-background', 'light'));

    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(1.5);
  });
});

describe('the measurement itself', () => {
  it('agrees with the WCAG reference values', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBe(21);
    expect(contrastRatio('#000000', '#000000')).toBe(1);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  it('rejects a value that is not a six-digit hex colour', () => {
    expect(() => contrastRatio('red', '#ffffff')).toThrow(/six-digit hex colour/);
  });
});
