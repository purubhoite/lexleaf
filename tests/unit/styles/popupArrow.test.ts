import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sources, tokenValue, withoutComments } from './stylesheetSource';

/**
 * The popup arrow straddles two files (Milestone 6.3).
 *
 * Its size and the popup's corner radius are tokens in `tokens.css`; how
 * far it must stay from the corners is `POPUP_ARROW_INSET`, a number in
 * `placePopup.ts`, because placement is arithmetic and happens before any
 * stylesheet is consulted. Nothing in the language ties the two together,
 * so this test does: it reads the constant out of the source and checks it
 * against the tokens. Make the arrow bigger or the corner rounder without
 * touching the inset and this fails, instead of the arrow quietly being
 * drawn across the curve.
 */

const placePopupSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/reader/dictionary/placePopup.ts'),
  'utf8',
);

const constantValue = (name: string): number => {
  const match = new RegExp(`export const ${name} = (-?[\\d.]+);`).exec(placePopupSource);

  if (match === null) {
    throw new Error(`${name} is not exported from placePopup.ts.`);
  }

  return Number.parseFloat(match[1] ?? '');
};

const pixels = (token: string): number => Number.parseFloat(tokenValue(token).replace('px', ''));

describe('the popup arrow', () => {
  const arrowSize = (): number => pixels('--popup-arrow-size');
  const cornerRadius = (): number => pixels('--radius-md');

  it('is sized by a token rather than a literal', () => {
    expect(tokenValue('--popup-arrow-size')).toBe('10px');
  });

  it('stays clear of the rounded corner and of its own rotated width', () => {
    // Rotated a quarter turn, a square of side S is S * sqrt(2) across, so
    // its centre must sit at least half of that plus the corner radius
    // away from the popup's edge.
    const required = cornerRadius() + (arrowSize() * Math.SQRT2) / 2;

    expect(constantValue('POPUP_ARROW_INSET')).toBeGreaterThanOrEqual(required);
  });

  it('fits inside the gap the placement leaves above the word', () => {
    // The visible triangle is half the rotated square. It must not reach
    // across the gap and touch the word it is pointing at.
    const visible = (arrowSize() * Math.SQRT2) / 2;

    expect(visible).toBeLessThan(constantValue('POPUP_GAP'));
  });

  it('is drawn from the popup surface tokens, so it cannot drift from it', () => {
    const css = withoutComments(sources.reader);
    const rule = /\.dictionary-popup__arrow \{([^}]*)\}/.exec(css)?.[1] ?? '';

    expect(rule).toContain('var(--popup-arrow-size)');
    expect(rule).toContain('background-color: var(--colour-surface)');
  });

  it('is drawn on both sides of the popup, pointing the right way each time', () => {
    const css = withoutComments(sources.reader);
    const below = /\.dictionary-popup--below \.dictionary-popup__arrow \{([^}]*)\}/.exec(css)?.[1];
    const above = /\.dictionary-popup--above \.dictionary-popup__arrow \{([^}]*)\}/.exec(css)?.[1];

    // Below the word, the arrow is on the popup's top edge; above it, on
    // the bottom edge. Each draws the two borders that face outwards.
    expect(below).toMatch(/top:\s*calc\(-0\.5 \* var\(--popup-arrow-size\)\)/);
    expect(below).toContain('border-top');
    expect(below).toContain('border-left');
    expect(above).toMatch(/bottom:\s*calc\(-0\.5 \* var\(--popup-arrow-size\)\)/);
    expect(above).toContain('border-right');
    expect(above).toContain('border-bottom');
  });

  it('does not animate: motion is 6.7', () => {
    const css = withoutComments(sources.reader);
    const rules = [
      ...css.matchAll(/\.dictionary-popup(?:__arrow|--\w+ \.dictionary-popup__arrow) \{([^}]*)\}/g),
    ];

    expect(rules).not.toHaveLength(0);
    for (const [, body] of rules) {
      expect(body).not.toMatch(/transition|animation/);
    }
  });
});

describe('the popup surface', () => {
  it('scrolls in an inner box, so the arrow is not clipped away', () => {
    const css = withoutComments(sources.reader);
    const outer = /\.dictionary-popup \{([^}]*)\}/.exec(css)?.[1] ?? '';
    const inner = /\.dictionary-popup__scroll \{([^}]*)\}/.exec(css)?.[1] ?? '';

    // `overflow` of anything but `visible` on the outer box would clip an
    // absolutely positioned child that crosses its edge — which is the
    // arrow's whole job.
    expect(outer).not.toMatch(/overflow/);
    expect(inner).toMatch(/overflow-y:\s*auto/);
  });

  it('keeps the border and the background on the box the arrow belongs to', () => {
    const css = withoutComments(sources.reader);
    const outer = /\.dictionary-popup \{([^}]*)\}/.exec(css)?.[1] ?? '';

    expect(outer).toContain('border: var(--border-width) solid var(--colour-border)');
    expect(outer).toContain('background-color: var(--colour-surface)');
  });
});
