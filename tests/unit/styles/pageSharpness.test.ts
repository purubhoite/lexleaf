/**
 * The page is drawn crisp, and the chrome scrolls with its own bars.
 *
 * Two defects, both measured rather than assumed (0.2.9):
 *
 * 1. Every page was slightly soft. A page's box is `page width x zoom`,
 *    which is almost never a whole number of pixels — at 169 % a 612 pt
 *    page is 1006.015625 wide — but its bitmap has to be a whole number.
 *    The canvas was stretched from its bitmap to that box
 *    (`.page__canvas { width: 100% }`), so Chromium resampled every pixel
 *    of every page by a factor of 1.0000155, and the softness showed on the
 *    thin strokes of serif type. Measured on a real PDF through PDF.js, at
 *    169 %, in this engine: about 13 % sharper once the canvas is sized
 *    from its own bitmap. Snapping the page's *position* to whole pixels,
 *    and replacing its centring translate, both made no difference at all:
 *    only the canvas did. That is why this change touches the canvas alone.
 *
 * 2. The saved-words panel had a horizontal scrollbar and a second vertical
 *    one. `overflow-y: auto` on `.shell__panel` computes `overflow-x: auto`
 *    as well, `.library` scrolled inside it on both axes, and the list's
 *    18rem tracks stayed 18rem wide inside a 287-pixel content box. Long
 *    file names with no spaces in them finished the job.
 *
 * These are source tests. They pin the properties whose absence caused each
 * defect, and the one place a scroller is allowed to be.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { splitDocumentSurface, sources, withoutComments } from './stylesheetSource';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** One file of the source tree, read as text. */
const readSource = (relative: string): string =>
  readFileSync(join(REPOSITORY_ROOT, relative), 'utf8');

const reader = splitDocumentSurface(sources.reader);
const chrome = withoutComments(sources.global);

/** One `selector { body }` rule, without its comments. */
const ruleBody = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);

  if (match?.[1] === undefined) {
    throw new Error(`No rule for ${selector}.`);
  }

  return match[1];
};

describe('the page is drawn at one bitmap pixel per device pixel', () => {
  const page = ruleBody(withoutComments(reader.document), '.page');
  const canvas = ruleBody(withoutComments(reader.document), '.page__canvas');

  it('sizes the canvas from its bitmap in the renderer, not from the page box', () => {
    // The renderer sets `canvas.style.width` from `bitmap / pixelRatio`
    // after every draw. A stylesheet rule that stretches the canvas to the
    // page again would undo the fix, so the stylesheet must not do that.
    const renderer = readSource('src/renderer/src/reader/pdf/renderPage.ts');

    expect(renderer).toMatch(/canvas\.style\.width/);
    expect(renderer).toMatch(/canvas\.style\.height/);
    expect(canvas).not.toMatch(/width:\s*100%/);
    expect(canvas).not.toMatch(/height:\s*100%/);
  });

  it('leaves the page box alone, because moving it does not help', () => {
    // Measured, and left in place deliberately: the page is still centred
    // with a translate, because moving it to whole pixels changed nothing
    // once the canvas was fixed. Anyone inclined to "sharpen" the page by
    // moving it can read the measurement here instead.
    expect(page).toMatch(/left:\s*50%/);
    expect(page).toMatch(/transform:\s*translateX\(-50%\)/);
  });

  it('still knows where a two-page spread puts it', () => {
    // PageSurface.tsx sets `left` per page in the two-page view, and turns
    // the centring translate off with it. Losing that would put the second
    // page of every spread under the middle of the window.
    const surface = readSource('src/renderer/src/reader/PageSurface.tsx');

    expect(surface).toMatch(/left: `calc\(50% \+ \$\{String\(left\)\}px\)`/);
    expect(surface).toMatch(/transform:\s*'none'/);
  });
});

describe('the saved-words panel scrolls in one direction', () => {
  it('is the only scroller in the panel', () => {
    const library = ruleBody(chrome, '.library');

    expect(library).not.toMatch(/overflow/);
  });

  it('cannot scroll sideways', () => {
    const panel = ruleBody(chrome, '.shell__panel');
    const vertical = /overflow:\s*auto/.test(panel) || /overflow-y:\s*auto/.test(panel);

    expect(vertical, 'the panel scrolls up and down').toBe(true);
    // Either form is fine as long as the horizontal axis is locked: `auto`
    // on both axes, which `overflow-y` alone would compute anyway, is the
    // defect this test exists for.
    expect(panel).toMatch(/overflow-x:\s*hidden/);
  });

  it('lets its controls shrink to the space it has', () => {
    const control = ruleBody(chrome, '.library__control');

    expect(control).toMatch(/min-width:\s*0/);
    expect(control).toMatch(/flex:\s*1 1 /);
  });

  it('caps a card track at the width the panel has, and wraps long names', () => {
    const list = ruleBody(chrome, '.library__list');

    expect(list).toMatch(/minmax\(min\(18rem, 100%\), 1fr\)/);
    // The track cap above is the list's own rule; the minimum a card may
    // shrink to is stated on the card and on every list item.
    expect(chrome).toMatch(/\.library__list > \* \{[^}]*min-width:\s*0/);
    expect(ruleBody(chrome, '.library__card')).toMatch(/min-width:\s*0/);
    expect(ruleBody(chrome, '.library__provenance')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('scrollbars are drawn as the application draws them', () => {
  it('uses only the webkit family, because the standard properties win', () => {
    // Setting `scrollbar-width` or `scrollbar-color` makes Chromium ignore
    // every `::-webkit-scrollbar` rule, and the platform bar comes back with
    // its arrow steppers. The empty rule is the record of that decision.
    const scroller = ruleBody(chrome, '.scroller');

    expect(scroller).not.toMatch(/scrollbar-width|scrollbar-color/);
    expect(chrome).toMatch(/\.scroller::-webkit-scrollbar-thumb/);
    expect(chrome).toMatch(/\.scroller::-webkit-scrollbar-button/);
    expect(chrome).toMatch(/background-clip:\s*content-box/);
  });

  it('thumbs every surface that scrolls', () => {
    // Each is a scroller a reader meets: the side panel, the reader itself,
    // its notices, the contents list, the sidebar, the popup and settings.
    const files = [
      'src/renderer/src/app/App.tsx',
      'src/renderer/src/reader/ReaderView.tsx',
      'src/renderer/src/reader/OutlinePanel.tsx',
      'src/renderer/src/reader/sidebar/ReaderSidebar.tsx',
      'src/renderer/src/reader/dictionary/WordDefinitionPopup.tsx',
      'src/renderer/src/settings/SettingsPanel.tsx',
    ];

    for (const file of files) {
      expect(readSource(file), file).toMatch(/className="[^"]*\bscroller\b/);
    }
  });
});
