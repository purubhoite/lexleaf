/**
 * Structural tests for the design-token layer (ADR-029, Milestone 6.1).
 *
 * These are source tests, not rendering tests: they assert that the token
 * layer *is* the only place values are written down, that nothing refers to a
 * name that does not exist, that the document surface stays outside the
 * system, and that the dead rules found by the Milestone 6 investigation
 * (docs/M6_PRODUCT_UX_INVESTIGATION.md, W14) stay removed.
 */

import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_SURFACE_END,
  DOCUMENT_SURFACE_START,
  componentSources,
  declarationsOf,
  definedTokens,
  flattenAtRules,
  paletteBlock,
  referencedTokens,
  selectedClasses,
  sources,
  splitDocumentSurface,
  withoutComments,
} from './stylesheetSource';

const reader = splitDocumentSurface(sources.reader);
const chrome = `${sources.global}\n${reader.chrome}`;

/**
 * PDF.js sets these on the text layer itself; they belong to the document
 * surface and are deliberately not application tokens.
 */
const PDF_JS_PROPERTIES = ['--total-scale-factor', '--font-height', '--scale-x', '--rotate'];

/**
 * ADR-029 enumerates these by name — the six-step type scale and the three
 * radii — so they are declared even though no rule reads them yet.
 * Everything else obeys "a token exists because a rule uses it"; this list
 * is the whole of the exception and is expected to shrink, never to grow.
 *
 * It shrank in 6.7: the motion family was declared here for a year of
 * milestones with no consumer, and ADR-032's four animations now spend
 * every one of the six names.
 */
const DECLARED_BUT_NOT_YET_CONSUMED = ['--text-xl', '--radius-lg'];

/**
 * Class names no `className` literal contains: the highlight modifiers are
 * composed at runtime in reader/PageSurface.tsx, and `markedContent` is put on
 * the page by PDF.js itself.
 */
const CLASSES_WITHOUT_A_LITERAL_USER = ['markedContent'];

/** Composed at runtime from a highlight kind in reader/PageSurface.tsx. */
const DYNAMICALLY_COMPOSED_CLASSES = [
  'highlight--match',
  'highlight--current-match',
  'highlight--occurrence',
  'highlight--cursor',
];

describe('tokens.css', () => {
  it('is imported before every other stylesheet', () => {
    const order = ['./styles/tokens.css', './styles/global.css', './styles/reader.css'].map(
      (specifier) => sources.main.indexOf(specifier),
    );

    expect(order.every((position) => position > -1)).toBe(true);
    expect(order).toStrictEqual([...order].sort((a, b) => a - b));
  });

  it('declares custom properties and nothing a component could depend on', () => {
    const selectors = flattenAtRules(withoutComments(sources.tokens))
      .split('}')
      .map((block) => block.split('{')[0]?.trim() ?? '')
      .filter((selector) => selector.length > 0);

    /*
     * 6.1 allowed `:root` alone. ADR-030 adds the two appearance selectors
     * and nothing else: the list is exhaustive, so a stylesheet that began
     * to style a component from the token file — or a third theme — still
     * fails here.
     */
    expect(selectors).toStrictEqual([
      ':root',
      ":root[data-theme='light']",
      ":root[data-theme='system']",
    ]);
    expect(selectedClasses(sources.tokens)).toStrictEqual([]);
  });

  it('names a value once within each appearance', () => {
    // Across appearances a name is *meant* to appear more than once; that
    // the two light blocks agree exactly is theme.test.ts's assertion.
    for (const palette of ['dark', 'light', 'light-system'] as const) {
      const defined = definedTokens(paletteBlock(palette));

      expect({ palette, duplicates: defined.length - new Set(defined).size }).toStrictEqual({
        palette,
        duplicates: 0,
      });
    }
  });

  it('declares every token family the foundation requires', () => {
    const defined = new Set(definedTokens(sources.tokens));
    const required = [
      '--colour-background',
      '--colour-surface',
      '--colour-text',
      '--colour-text-muted',
      '--colour-border',
      '--colour-border-strong',
      '--colour-control',
      '--colour-focus',
      '--colour-accent',
      '--colour-danger',
      '--colour-problem',
      '--colour-highlight-match',
      '--colour-highlight-current',
      '--colour-highlight-occurrence',
      '--colour-highlight-cursor',
      '--colour-selection',
      '--font-ui',
      '--font-mono',
      '--text-base',
      '--line-base',
      '--space-1',
      '--radius-sm',
      '--shadow-popup',
      '--control-min-size',
      '--motion-base',
      '--ease-standard',
    ];

    expect(required.filter((token) => !defined.has(token))).toStrictEqual([]);
  });
});

describe('the stylesheets consume the token layer', () => {
  it('refers to no custom property that tokens.css does not define', () => {
    const defined = new Set(definedTokens(sources.tokens));
    const used = new Set([
      ...referencedTokens(sources.global),
      ...referencedTokens(sources.reader),
    ]);
    const undefinedTokens = [...used].filter(
      (token) => !defined.has(token) && !PDF_JS_PROPERTIES.includes(token),
    );

    expect(undefinedTokens).toStrictEqual([]);
  });

  it('defines no token that no rule uses', () => {
    const used = new Set([
      ...referencedTokens(sources.global),
      ...referencedTokens(sources.reader),
      ...referencedTokens(sources.tokens),
    ]);
    const unused = definedTokens(sources.tokens).filter(
      (token) => !used.has(token) && !DECLARED_BUT_NOT_YET_CONSUMED.includes(token),
    );

    expect(unused).toStrictEqual([]);
  });

  it('uses no var() fallback in application chrome', () => {
    // A fallback hides a missing token; W1 was only invisible because of one.
    expect(withoutComments(chrome)).not.toMatch(/var\(\s*--[\w-]+\s*,/);
  });

  it('writes no colour literal outside tokens.css and the document surface', () => {
    expect(withoutComments(chrome)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(withoutComments(chrome)).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/);
  });

  it('writes no font-size, radius or shadow literal in application chrome', () => {
    for (const value of declarationsOf(chrome, 'font-size')) {
      expect(value).toMatch(/^(?:inherit|var\(--text-)/);
    }

    for (const value of declarationsOf(chrome, 'border-radius')) {
      expect(value).toMatch(/^var\(--radius-/);
    }

    for (const value of declarationsOf(chrome, 'box-shadow')) {
      expect(value).toMatch(/^var\(--shadow-/);
    }
  });

  it('writes no motion duration or easing curve as a literal', () => {
    /*
     * 6.7 spent the motion family. Before it did, this test asserted that
     * no `transition` or `animation` existed at all; what it was really
     * protecting is that a duration is a reviewed decision in one file
     * rather than a number someone typed into a rule, so it now says that
     * instead. ADR-032's `linear` is a keyword, not a duration, and the
     * reduced-motion override's `none` is the absence of one.
     */
    const declared = [
      ...declarationsOf(chrome, 'transition'),
      ...declarationsOf(chrome, 'animation'),
    ].filter((value) => value !== 'none');

    expect(declared).not.toStrictEqual([]);
    for (const value of declared) {
      expect(value).toMatch(/var\(--motion-/);
      expect(value).not.toMatch(/\b\d+(?:\.\d+)?m?s\b/);
      expect(value.replace(/var\([^)]*\)/g, '')).not.toMatch(/cubic-bezier|\bease\b|ease-[a-z-]+/);
    }
  });
});

describe('the document surface stays outside the token system', () => {
  it('is marked as a region', () => {
    expect(sources.reader).toContain(DOCUMENT_SURFACE_START);
    expect(sources.reader).toContain(DOCUMENT_SURFACE_END);
  });

  it('keeps the page white and the text layer intact', () => {
    expect(reader.document).toMatch(/\.page\s*\{[^}]*background-color:\s*#ffffff/);
    expect(reader.document).toContain('.textLayer');
    expect(reader.document).toMatch(/\.textLayer :is\(span, br\) \{[^}]*color: transparent/);
    expect(reader.document).toMatch(/font-size: calc\(var\(--total-scale-factor, 1\)/);
  });

  it('is the only place the highlight colours live', () => {
    for (const highlight of DYNAMICALLY_COMPOSED_CLASSES) {
      expect(reader.document).toContain(`.${highlight}`);
      expect(reader.chrome).not.toContain(`.${highlight}`);
    }
  });
});

describe('the control primitive', () => {
  const control = /\.control \{([^}]*)\}/.exec(withoutComments(sources.global))?.[1] ?? '';

  it('exists in the shared layer', () => {
    expect(control).not.toBe('');
  });

  it('is never smaller than the minimum target size', () => {
    expect(control).toMatch(/min-height:\s*var\(--control-min-size\)/);
    expect(control).toMatch(/min-width:\s*var\(--control-min-size\)/);
    // 1.5rem at the 16px root size is 24px: WCAG 2.2 section 2.5.8.
    expect(declarationsOf(sources.tokens, '--control-min-size')).toStrictEqual(['1.5rem']);
  });

  it('draws its own focus ring from the focus token', () => {
    expect(withoutComments(sources.global)).toMatch(
      /\.control:focus-visible \{[^}]*outline:\s*var\(--focus-ring-width\) solid var\(--colour-focus\)/,
    );
  });

  it('shows a hover and a disabled state', () => {
    expect(withoutComments(sources.global)).toMatch(/\.control:hover:enabled \{/);
    expect(withoutComments(sources.global)).toMatch(/\.control:disabled \{/);
  });

  it('is what every per-component button rule was replaced by', () => {
    // The six rule groups listed in the investigation (W5) are gone.
    const replaced = [
      '.shell__library-toggle {',
      '.library__control input',
      '.reader__bar button,',
      '.search :is(button, input) {',
      '.start button {',
      '.dictionary-popup__context',
    ];

    for (const rule of replaced) {
      expect(chrome).not.toContain(rule);
    }
  });
});

describe('accessibility presentation utilities', () => {
  const visuallyHidden = /\.visually-hidden \{([^}]*)\}/.exec(withoutComments(sources.global))?.[1];

  it('hides text visually without removing it from the accessibility tree', () => {
    expect(visuallyHidden).toBeDefined();
    expect(visuallyHidden).not.toMatch(/display:\s*none/);
    expect(visuallyHidden).not.toMatch(/visibility:\s*hidden/);
    expect(visuallyHidden).toMatch(/white-space:\s*nowrap/);
    expect(visuallyHidden).toMatch(/clip-path:\s*inset\(50%\)/);
  });

  it('is declared once, in the shared layer only', () => {
    expect(sources.reader).not.toContain('.visually-hidden {');
  });
});

describe('dead presentation rules', () => {
  it('no longer exist', () => {
    // W14: verified against every className in the renderer.
    for (const selector of [
      '.card',
      '.shell__subtitle',
      '.reader__hint',
      '.dictionary-popup__hint',
      '.dictionary-popup__context',
    ]) {
      expect(withoutComments(sources.global)).not.toContain(`${selector} `);
      expect(withoutComments(sources.reader)).not.toContain(`${selector} `);
      expect(withoutComments(sources.reader)).not.toContain(`${selector},`);
    }
  });

  it('are not replaced by new ones: every class selected has a user', () => {
    const renderer = componentSources();

    const unused = [...selectedClasses(sources.global), ...selectedClasses(sources.reader)].filter(
      (className) =>
        !renderer.includes(className) &&
        !DYNAMICALLY_COMPOSED_CLASSES.includes(className) &&
        !CLASSES_WITHOUT_A_LITERAL_USER.includes(className),
    );

    expect(unused).toStrictEqual([]);
  });
});
