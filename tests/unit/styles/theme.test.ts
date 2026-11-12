/**
 * The theme, as a property of the source (ADR-030, Milestone 6.6).
 *
 * A theme is mostly a cascade, and a cascade is not something jsdom can
 * resolve: it implements no media query and computes no custom property.
 * These tests therefore assert the things that decide what the cascade will
 * do — which palettes exist, which selectors they hang off, which names each
 * one defines, and which values the two processes agree on — and the things
 * that must *not* be in the source at all. What a real engine then makes of
 * it is verified at runtime in Electron and recorded in
 * docs/PDF_SPIKE_REPORT.md §10.
 *
 * Every assertion here has a failure mode that matters: a missing light
 * value, a light palette that reaches the document surface, a window colour
 * that drifts from the stylesheet, a `matchMedia` call appearing in the
 * renderer, or an explicit choice that the system could override.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  THEME_ATTRIBUTE_WRITE,
  composite,
  contrastRatio,
  declaredValue,
  definedTokens,
  flattenAtRules,
  paletteBlock,
  paletteValue,
  rendererModules,
  sources,
  splitDocumentSurface,
  stripComments,
  withoutComments,
  type Palette,
} from './stylesheetSource';

const APPLY_APPEARANCE = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
  'src/renderer/src/theme/applyAppearance.ts',
);

const tokens = withoutComments(sources.tokens);
const reader = splitDocumentSurface(sources.reader);

/** The names every palette must resolve, grouped as ADR-029 groups them. */
const SEMANTIC_COLOURS = [
  '--colour-background',
  '--colour-surface',
  '--colour-surface-raised',
  '--colour-scroller',
  '--colour-text',
  '--colour-text-muted',
  '--colour-border',
  '--colour-border-strong',
  '--colour-control',
  '--colour-control-hover',
  '--colour-focus',
  '--colour-accent',
  '--colour-danger',
  '--colour-problem',
] as const;

/**
 * The document surface: painted on white paper in both appearances, so the
 * same value in both. ADR-030 forbids theming any of it.
 */
const DOCUMENT_SURFACE_TOKENS = [
  '--colour-highlight-match',
  '--colour-highlight-current',
  '--colour-highlight-occurrence',
  '--colour-highlight-cursor',
  '--colour-selection',
] as const;

const LIGHT_PALETTES: readonly Palette[] = ['light', 'light-system'];

describe('the three appearances', () => {
  it('are the only selectors tokens.css uses', () => {
    const selectors = flattenAtRules(tokens)
      .split('}')
      .map((block) => block.split('{')[0]?.trim() ?? '')
      .filter((selector) => selector.length > 0);

    expect(selectors).toStrictEqual([
      ':root',
      ":root[data-theme='light']",
      ":root[data-theme='system']",
    ]);
  });

  it('give the system palette a media query and the explicit one none', () => {
    // The explicit rule must sit outside the query, or an explicit choice
    // would only apply when the system already agreed with it.
    const [beforeQuery] = tokens.split('@media');

    expect(beforeQuery).toContain(":root[data-theme='light']");
    expect(beforeQuery).not.toContain(":root[data-theme='system']");
    expect(tokens).toMatch(
      /@media \(prefers-color-scheme: light\) \{\s*:root\[data-theme='system'\]/,
    );
  });

  it('leave an explicit dark root on the base palette', () => {
    // There is no `[data-theme='dark']` rule, and there must not be one:
    // `:root` is already the dark palette, so an explicit dark root matches
    // neither light rule and cannot be reached by the media query.
    expect(tokens).not.toContain("data-theme='dark'");
    expect(tokens).toMatch(/:root \{[^}]*--colour-background: #11141a/);
  });

  it('use no media feature other than the colour-scheme preference', () => {
    const features = [...tokens.matchAll(/@media\s*\(([^)]*)\)/g)].map((match) => match[1]);

    expect(features).toStrictEqual(['prefers-color-scheme: light']);
  });

  it('declare a colour-scheme for each palette, so native widgets follow', () => {
    expect(paletteBlock('dark')).toMatch(/color-scheme:\s*dark/);

    for (const palette of LIGHT_PALETTES) {
      expect(paletteBlock(palette)).toMatch(/color-scheme:\s*light/);
    }
  });
});

describe('palette completeness', () => {
  it.each(LIGHT_PALETTES)('%s resolves every semantic chrome colour', (palette) => {
    for (const token of SEMANTIC_COLOURS) {
      expect(() => paletteValue(token, palette)).not.toThrow();
      expect(paletteValue(token, palette)).not.toBe('');
    }
  });

  it('gives the light appearance its own value for every colour that needs one', () => {
    // A light palette that merely inherited the dark one would pass a
    // "defines every token" test while looking identical. These are the
    // names whose dark value cannot work on a light surface.
    const mustDiffer = SEMANTIC_COLOURS.filter((token) => token !== '--colour-control');
    const unchanged = mustDiffer.filter(
      (token) => paletteValue(token, 'light') === paletteValue(token, 'dark'),
    );

    expect(unchanged).toStrictEqual([]);
  });

  it('keeps the control fill pointing at the raised surface in both palettes', () => {
    // `--colour-control: var(--colour-surface-raised)` is defined once; it
    // must resolve per palette rather than being restated.
    expect(paletteBlock('light')).not.toContain('--colour-control:');
    expect(paletteValue('--colour-control', 'light')).toBe(
      paletteValue('--colour-surface-raised', 'light'),
    );
    expect(paletteValue('--colour-control', 'dark')).toBe(
      paletteValue('--colour-surface-raised', 'dark'),
    );
  });

  it('writes the light palette identically in both places it appears', () => {
    const named = (palette: Palette): Map<string, string> =>
      new Map(
        [...paletteBlock(palette).matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;]+);/g)].map(
          (match) => [match[1] ?? '', (match[2] ?? '').trim()],
        ),
      );

    const explicit = named('light');
    const system = named('light-system');

    expect([...system.keys()].sort()).toStrictEqual([...explicit.keys()].sort());

    for (const [name, value] of explicit) {
      expect({ name, value: system.get(name) }).toStrictEqual({ name, value });
    }
  });

  it('adds no token that only one appearance knows about', () => {
    const base = new Set(definedTokens(paletteBlock('dark')));

    for (const palette of LIGHT_PALETTES) {
      const extra = definedTokens(paletteBlock(palette)).filter((token) => !base.has(token));

      expect({ palette, extra }).toStrictEqual({ palette, extra: [] });
    }
  });

  it('keeps the six families: no parallel light naming scheme', () => {
    const names = definedTokens(tokens);

    // No `--colour-light-surface`, no `--palette-dark-text`: a name may
    // not have an appearance as one of its segments.
    expect(
      names.filter((name) => /(?:^|-)(?:light|dark|theme|palette)(?:-|$)/i.test(name)),
    ).toStrictEqual([]);

    for (const name of names) {
      expect(name).toMatch(
        /^--(?:colour|font|text|line|space|radius|border|focus|control|checkbox|popup|shadow|motion|ease)-/,
      );
    }
  });
});

describe('the document surface is not themed', () => {
  it.each(DOCUMENT_SURFACE_TOKENS)('%s is the same colour in both appearances', (token) => {
    expect(paletteValue(token, 'light')).toBe(paletteValue(token, 'dark'));
    expect(paletteValue(token, 'light-system')).toBe(paletteValue(token, 'dark'));
  });

  it('is not mentioned by either light palette', () => {
    for (const palette of LIGHT_PALETTES) {
      const block = paletteBlock(palette);

      for (const token of DOCUMENT_SURFACE_TOKENS) {
        expect({ palette, token, present: block.includes(token) }).toStrictEqual({
          palette,
          token,
          present: false,
        });
      }
    }
  });

  it('keeps the page white, with no theme selector able to reach it', () => {
    expect(reader.document).toMatch(/\.page\s*\{[^}]*background-color:\s*#ffffff/);
    expect(withoutComments(sources.reader)).not.toContain('data-theme');
    expect(withoutComments(sources.global)).not.toContain('data-theme');
    expect(withoutComments(sources.reader)).not.toContain('prefers-color-scheme');
    expect(withoutComments(sources.global)).not.toContain('prefers-color-scheme');
  });

  it('draws the page, its edge and its overlay from values no palette can change', () => {
    // 6.6 replaced the three chrome tokens that used to be read here: a
    // light `--colour-border` would have dissolved the page's edge, and a
    // light `--colour-text` would have put dark text on the overlay's
    // deliberately dark panel.
    const page = /\.page \{([^}]*)\}/.exec(withoutComments(reader.document))?.[1] ?? '';
    const overlay = /\.page__overlay \{([^}]*)\}/.exec(withoutComments(reader.document))?.[1] ?? '';
    const problem =
      /\.page__overlay--problem \{([^}]*)\}/.exec(withoutComments(reader.document))?.[1] ?? '';

    expect(page).toMatch(/box-shadow:\s*0 0 0 1px #2b323e/);
    expect(overlay).toMatch(/background-color:\s*rgb\(17 20 26 \/ 85%\)/);

    for (const block of [page, overlay, problem]) {
      expect(block).not.toMatch(/var\(--colour-(?:text|border|problem|background|surface)/);
    }
  });

  it('keeps both overlay messages legible on the panel they are painted on', () => {
    // Until the 6.6 audit this read `#653a00 or #e8b45a`, and the first of
    // those is the light palette's problem colour: 1.22:1 on this panel.
    // The alternation made the one regression the pinning exists to stop
    // into a passing value, so the contract is now the readability itself,
    // computed from what `reader.css` declares rather than from a copy of
    // it. The overlay is translucent, so the colour that matters is the
    // composite over the page, not the panel colour as written.
    const document = reader.document;
    const panel = composite(
      declaredValue(document, '.page__overlay', 'background-color'),
      declaredValue(document, '.page', 'background-color'),
    );

    expect(panel).toBe('#35373c');

    const message = declaredValue(document, '.page__overlay', 'color');
    const problem = declaredValue(document, '.page__overlay--problem', 'color');

    // Literals, not tokens: a value that moved with the appearance would be
    // a document-surface colour the chrome theme reaches into.
    for (const colour of [message, problem]) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    }

    expect(contrastRatio(message, panel)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(problem, panel)).toBeGreaterThanOrEqual(4.5);

    // A problem must still look different from an ordinary message: the two
    // are not allowed to collapse into one colour.
    expect(problem).not.toBe(message);
  });

  it('never blends or blurs the document, and never filters the chrome', () => {
    for (const property of ['backdrop-filter', 'mix-blend-mode', 'invert']) {
      expect(withoutComments(sources.reader)).not.toContain(`${property}:`);
      expect(withoutComments(sources.global)).not.toContain(`${property}:`);
    }

    expect(withoutComments(sources.global)).not.toContain('filter:');
  });

  it('filters the page only where the reader chose a page colour (0.2.3)', () => {
    // The appearance still never recolours a page. The one way a page is
    // shown differently is the reader's own "Page colour" setting, and
    // every filter in the stylesheet belongs to one of its three values.
    const filtered = [...withoutComments(sources.reader).matchAll(/([^{}]+)\{[^}]*filter:/gu)].map(
      (match) => (match[1] ?? '').trim(),
    );

    expect(filtered).toStrictEqual([
      '.reader__pages--sepia .page',
      '.reader__pages--dimmed .page',
      '.reader__pages--dark .page',
    ]);
  });

  it('still keeps the highlights distinguishable by more than hue', () => {
    // Outlines, not just fills: the four meanings survive in greyscale and
    // in both appearances, because neither appearance changes them.
    const document = withoutComments(reader.document);

    expect(document).toMatch(/\.highlight--current-match \{[^}]*outline: 1px solid/);
    expect(document).toMatch(/\.highlight--occurrence \{[^}]*outline: 2px solid/);
    expect(document).toMatch(/\.highlight--cursor \{[^}]*outline: 2px solid/);
    expect(document).toMatch(/\.highlight--match \{[^}]*background-color/);
  });
});

describe('the renderer module scan', () => {
  // The two rules below are only worth what this list covers. Until the 6.6
  // audit it covered `.tsx` alone, so a `matchMedia` call or a second writer
  // in any of the renderer's `.ts` modules passed unseen.
  const modules = rendererModules();
  const paths = modules.map((module) => module.path);

  it('covers both kinds of renderer module, and no tests', () => {
    expect(paths).toContain('src/renderer/src/theme/applyAppearance.ts');
    expect(paths).toContain('src/renderer/src/main.tsx');

    const typescript = paths.filter((path) => path.endsWith('.ts'));
    const components = paths.filter((path) => path.endsWith('.tsx'));

    expect(typescript.length).toBeGreaterThan(10);
    expect(components.length).toBeGreaterThan(5);
    expect(paths.filter((path) => /\.test\.tsx?$/.test(path))).toStrictEqual([]);
  });

  it('reads code, not prose', () => {
    // `applyAppearance.ts` explains at length that it does not call
    // `matchMedia`. A scan that cannot tell the explanation from the call
    // would force the explanation out of the file.
    const applyAppearance = modules.find(
      (module) => module.path === 'src/renderer/src/theme/applyAppearance.ts',
    );

    expect(applyAppearance?.code).not.toContain('matchMedia');
    expect(readFileSync(APPLY_APPEARANCE, 'utf8')).toContain('matchMedia');

    expect(stripComments("const a = 1; // matchMedia\nconst b = '/* kept */';")).toBe(
      "const a = 1;              \nconst b = '/* kept */';",
    );
    expect(stripComments('/* nativeTheme */ const c = 2;')).toBe('                  const c = 2;');
  });
});

describe('the mechanism', () => {
  it('resolves the theme in CSS: no media query in application JavaScript', () => {
    const offenders = rendererModules().filter(
      (module) =>
        module.code.includes('matchMedia') || module.code.includes('prefers-color-scheme'),
    );

    expect(offenders.map((module) => module.path)).toStrictEqual([]);

    // The renderer never asks Electron either; `nativeTheme` is main-only.
    expect(
      rendererModules()
        .filter((module) => module.code.includes('nativeTheme'))
        .map((module) => module.path),
    ).toStrictEqual([]);

    // The main process resolves the system theme through `nativeTheme`, and
    // must not grow a second opinion of its own.
    expect(stripComments(sources.windowTheme)).not.toContain('matchMedia');
    expect(stripComments(sources.windowTheme)).not.toContain('prefers-color-scheme');
  });

  it('writes the attribute from exactly one place', () => {
    const writers = rendererModules().flatMap((module) => {
      const count = [...module.code.matchAll(THEME_ATTRIBUTE_WRITE)].length;

      return count === 0 ? [] : [{ path: module.path, writes: count }];
    });

    // Not an exclusion of the file: the one legitimate writer is named, and
    // writing the attribute anywhere else — in a component or in any other
    // renderer module — fails here.
    expect(writers).toStrictEqual([
      { path: 'src/renderer/src/theme/applyAppearance.ts', writes: 1 },
    ]);
    expect(sources.main).toContain('applyAppearance(document.documentElement');
  });

  it('ships the attribute in the document, so the first paint is already right', () => {
    expect(sources.html).toMatch(/<html[^>]*\bdata-theme="system"/);
  });

  it('agrees with the main process about the window background', () => {
    // The one value that exists in both processes. A drift here is the
    // flash of the wrong colour that ADR-030 exists to prevent.
    const colours: Record<string, string> = Object.fromEntries(
      [...sources.windowTheme.matchAll(/(dark|light):\s*'(#[0-9a-f]{6})'/g)].map((match) => [
        match[1] ?? '',
        match[2] ?? '',
      ]),
    );

    expect(colours).toStrictEqual({
      dark: paletteValue('--colour-background', 'dark'),
      light: paletteValue('--colour-background', 'light'),
    });
  });

  it('changes a theme instantly: a resting element carries no transition (ADR-032)', () => {
    /*
     * Until 6.7 this asserted that the word `transition` appeared nowhere.
     * Motion exists now, so the assertion has to say what it was always
     * protecting instead: swapping the palette under an element must
     * repaint it at once, not fade it. That holds as long as no element
     * is *sitting* in a state that carries a transition — ADR-032's
     * control transition is declared on the hovered and focused states,
     * which an idle element does not match, so the declaration disappears
     * at the same moment the colours change.
     *
     * The honest limit of this: an element that is hovered at the instant
     * the palette changes does cross-fade for 80 ms. That is the price of
     * the hover feedback and it is recorded in the completion report.
     *
     * `transition: none` is skipped: the reduced-motion override takes
     * motion away, so it can only make a theme change more instant.
     */
    const transitioning = [
      ...flattenAtRules(withoutComments(`${sources.global}\n${reader.chrome}`)).matchAll(
        /([^{}]+)\{([^{}]*)\}/g,
      ),
    ]
      .filter(([, , body]) => {
        const value = /(?:^|[;{])\s*transition\s*:([^;}]+)/.exec(body ?? '')?.[1]?.trim();

        return value !== undefined && value !== 'none';
      })
      .map(([, selector]) => (selector ?? '').trim().replace(/\s+/g, ' '));

    expect(transitioning).not.toStrictEqual([]);
    for (const selector of transitioning) {
      // Every part of the list, not just one of them: a rule that reads
      // `.control, .control:hover { transition: … }` would otherwise pass
      // while giving every idle control a transition.
      for (const part of selector.split(',')) {
        expect(part.trim()).toMatch(/:hover|:focus-visible/);
      }
    }
  });

  it('never animates the palette itself', () => {
    // tokens.css declares colours and durations; it must never be the
    // thing that moves. A transition written beside a palette would
    // animate every appearance change at once, everywhere.
    expect(tokens).not.toMatch(/transition\s*:/);
    expect(tokens).not.toMatch(/animation\s*:/);
    expect(tokens).not.toMatch(/@keyframes/);
  });
});
