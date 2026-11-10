/**
 * Structural accessibility invariants (Milestone 6.2).
 *
 * These are the parts of the accessibility baseline that live in the
 * stylesheet and in the shape of the markup, so they are provable from the
 * source: which element kinds the focus ring reaches, whether a target is
 * big enough to hit, whether a native control has been redrawn, and whether
 * a state is carried by colour alone. Behaviour — that a checkbox still
 * toggles, that a summary still opens, that a result is announced once — is
 * proved by the component tests next to those components.
 *
 * The coverage test deliberately does not hard-code the list of element
 * kinds: it reads them out of the renderer. A `<textarea>` added tomorrow
 * fails this suite until the focus rule reaches it.
 */

import { describe, expect, it } from 'vitest';

import {
  componentSources,
  declarationsOf,
  sources,
  splitDocumentSurface,
  tokenValue,
  withoutComments,
} from './stylesheetSource';

const reader = splitDocumentSurface(sources.reader);
const chrome = withoutComments(`${sources.global}\n${reader.chrome}`);
const document_ = withoutComments(reader.document);
const components = componentSources();

/** The rule that paints the application's focus ring. */
const focusRule = (): { selector: string; body: string } => {
  const match = /([^{}]+)\{([^{}]*outline:\s*var\(--focus-ring-width\)[^{}]*)\}/.exec(chrome);

  if (match === null) {
    throw new Error('No rule in the chrome paints the shared focus ring.');
  }

  return { selector: match[1] ?? '', body: match[2] ?? '' };
};

/** The declared value of one property inside a named rule. */
const declaration = (css: string, selector: string, property: string): string | null => {
  const rule = new RegExp(`(?:^|[}\\s])${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm').exec(
    css,
  );

  if (rule === null) {
    throw new Error(`No rule for ${selector}.`);
  }

  const value = new RegExp(`(?:^|[;{])\\s*${property}\\s*:([^;}]+)`).exec(rule[1] ?? '');

  return value === null ? null : (value[1] ?? '').trim();
};

/**
 * The element kinds the renderer actually renders, expressed as the
 * selector token that would have to appear in the focus rule.
 */
const interactiveKindsInUse = (): string[] => {
  const kinds: Array<[string, RegExp]> = [
    ['a', /<a[\s>]/],
    ['button', /<button[\s>]/],
    ['input', /<input[\s>]/],
    ['select', /<select[\s>]/],
    ['textarea', /<textarea[\s>]/],
    ['summary', /<summary[\s>]/],
    ['[tabindex]', /tabIndex=/],
  ];

  return kinds.filter(([, pattern]) => pattern.test(components)).map(([kind]) => kind);
};

describe('the focus ring reaches everything (A11Y-1, AC 7)', () => {
  it('covers every interactive element kind the renderer uses', () => {
    const selector = focusRule().selector;
    const missing = interactiveKindsInUse().filter((kind) => !selector.includes(kind));

    expect(missing).toEqual([]);
  });

  it('actually uses every kind this test knows how to check', () => {
    // Guards the test above against passing because it found nothing.
    expect(interactiveKindsInUse()).toEqual(
      expect.arrayContaining(['a', 'button', 'input', 'select', 'summary', '[tabindex]']),
    );
  });

  it('is drawn from the focus tokens, not a hand-picked colour', () => {
    const body = focusRule().body;

    expect(body).toContain('var(--colour-focus)');
    expect(body).toContain('var(--focus-ring-width)');
    expect(body).toContain('var(--focus-ring-offset)');
  });

  /*
   * The 6.2 audit (condition I-1) changed `--focus-ring-width` to 1px and
   * watched all 1412 tests pass: the suite checked that the ring was built
   * out of the tokens but never what the tokens said. Section 5.4 of the
   * investigation names the values — `outline: 2px solid var(--colour-focus)`
   * with a 2px offset — and WCAG 2.2 section 2.4.13 wants a focus perimeter
   * at least 2 CSS pixels thick, so both the approved value and the floor
   * are pinned. Reading through `tokenValue` means the *declaration* has to
   * change for this to pass, not merely the rule that consumes it.
   */
  describe.each([
    ['--focus-ring-width', '2px'],
    ['--focus-ring-offset', '2px'],
  ])('%s', (token, approved) => {
    it(`is declared exactly once, as ${approved}`, () => {
      expect(declarationsOf(sources.tokens, token)).toStrictEqual([approved]);
    });

    it('resolves to at least two CSS pixels', () => {
      const resolved = tokenValue(token);

      expect(resolved).toMatch(/^\d+(?:\.\d+)?px$/);
      expect(Number.parseFloat(resolved)).toBeGreaterThanOrEqual(2);
    });
  });

  it('is keyboard-only, so a pointer press leaves no ring behind', () => {
    expect(focusRule().selector).toContain(':focus-visible');
  });

  it('is never removed by another rule', () => {
    // `outline: none` is the classic way a focus indicator disappears.
    expect(chrome).not.toMatch(/outline:\s*(?:none|0)\s*[;}]/);
  });

  it('keeps zero specificity for the shared half of the selector', () => {
    // `:where()` is what lets a component opt out without `!important`.
    expect(focusRule().selector).toContain(':where(');
    expect(chrome).not.toContain('!important');
  });
});

/*
 * The 6.2 audit (condition C-1) found the ring declared in three places
 * while the record claimed one: the shared rule, a redundant copy on the
 * scroller, and a popup rule that silently overrode the offset the shared
 * rule had just set for it. The structure worked only by accident of
 * source order. These tests pin the structure that replaced it — one
 * authoritative rule, one declared exception — so a fourth copy cannot be
 * added without a failure.
 */
describe('the ring is declared in one place, with one documented exception (6.2 audit, C-1)', () => {
  /** Every rule in the chrome that paints the ring, selector and body. */
  const ringRules = (): Array<{ selector: string; body: string }> =>
    [...chrome.matchAll(/([^{}]+)\{([^{}]*outline:\s*var\(--focus-ring-width\)[^{}]*)\}/g)].map(
      (match) => ({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' }),
    );

  it('paints the ring from exactly two rules', () => {
    expect(ringRules()).toHaveLength(2);
  });

  it('names the popup as the only exception, and only for the offset', () => {
    const exception = ringRules().find((rule) => rule.selector.includes('.dictionary-popup'));

    expect(exception?.selector).toBe('.dictionary-popup:focus-visible');
    // Same width and colour as the shared rule: an exception, not a fork.
    expect(exception?.body).toContain('var(--focus-ring-width) solid var(--colour-focus)');
    expect(exception?.body).toMatch(/outline-offset:\s*calc\(-1 \* var\(--focus-ring-width\)\)/);
  });

  it('does not also list the popup in the shared rule, where it would be overridden', () => {
    expect(focusRule().selector).not.toContain('.dictionary-popup');
  });

  it('does not restate the ring for an element the shared rule already covers', () => {
    // `.reader__scroller` carries `tabindex="0"`, so `:where([tabindex])`
    // reaches it; the copy that used to sit in reader.css was dead weight.
    expect(chrome).not.toMatch(/\.reader__scroller:focus-visible/);
  });
});

describe('target size (A11Y-5, AC 4)', () => {
  it.each(['.control', '.checkbox', '.disclosure__summary'])(
    '%s is at least the minimum target high',
    (selector) => {
      expect(declaration(chrome, selector, 'min-height')).toBe('var(--control-min-size)');
    },
  );

  it('keeps the control primitive square-capable', () => {
    expect(declaration(chrome, '.control', 'min-width')).toBe('var(--control-min-size)');
  });

  it('pads the disclosure and the checkbox rather than relying on their text', () => {
    expect(declaration(chrome, '.disclosure__summary', 'padding')).not.toBeNull();
    expect(declaration(chrome, '.checkbox', 'padding')).not.toBeNull();
  });
});

describe('native controls stay native (6.1 audit, finding 4)', () => {
  it('redraws no platform control', () => {
    // `appearance: none` on a checkbox makes this application responsible
    // for drawing the checked glyph, which the investigation does not ask
    // for and which is how a tick becomes colour-only.
    expect(chrome).not.toMatch(/appearance\s*:/);
  });

  it('gives every checkbox in the renderer the shared checkbox presentation', () => {
    const checkboxes = [...components.matchAll(/type="checkbox"/g)].length;
    const styled = [...components.matchAll(/className="checkbox__input"/g)].length;

    expect(checkboxes).toBeGreaterThan(0);
    expect(styled).toBe(checkboxes);
  });

  it('gives every disclosure summary the shared disclosure presentation', () => {
    const summaries = [...components.matchAll(/<summary[\s>]/g)].length;
    const styled = [...components.matchAll(/className="disclosure__summary"/g)].length;

    expect(summaries).toBeGreaterThan(0);
    expect(styled).toBeGreaterThanOrEqual(summaries - 1);
  });

  it('does not change the display box of a summary', () => {
    // Chromium drops the open/closed marker when `<summary>` stops being a
    // list item, and that triangle is the non-colour carrier of the state.
    expect(declaration(chrome, '.disclosure__summary', 'display')).toBeNull();
  });

  it('never replaces a native control with a clickable div', () => {
    expect(components).not.toMatch(/<div[^>]*role="(?:button|checkbox|link)"/);
  });
});

describe('the skip link (A11Y-10)', () => {
  it('exists and is positioned rather than hidden', () => {
    // `display: none` and `visibility: hidden` both remove an element from
    // the tab order, which would make the link unreachable.
    const hiddenState = /\.skip-link:not\(:focus\)\s*\{([^}]*)\}/.exec(chrome)?.[1] ?? '';

    expect(hiddenState).not.toBe('');
    expect(hiddenState).not.toMatch(/display\s*:\s*none/);
    expect(hiddenState).not.toMatch(/visibility\s*:\s*hidden/);
    expect(hiddenState).toMatch(/clip-path/);
  });

  it('shows itself on plain focus, not only on focus-visible', () => {
    // A sighted keyboard user must see where they are; `:focus-visible`
    // alone would leave the link invisible in some activation paths.
    expect(chrome).toMatch(/\.skip-link:not\(:focus\)/);
  });
});

describe('colour is never the only carrier of meaning (A11Y-14)', () => {
  it('distinguishes the current search match by more than its colour', () => {
    const current = /\.highlight--current-match\s*\{([^}]*)\}/.exec(document_)?.[1] ?? '';

    expect(current).toMatch(/background-color/);
    expect(current).toMatch(/outline/);
  });

  it('distinguishes every highlight kind that carries a distinct meaning', () => {
    const kinds = ['--current-match', '--occurrence', '--cursor'];
    const withoutShape = kinds.filter((kind) => {
      const body = new RegExp(`\\.highlight${kind}\\s*\\{([^}]*)\\}`).exec(document_)?.[1] ?? '';

      return !body.includes('outline');
    });

    expect(withoutShape).toEqual([]);
  });

  it('carries the library toggle state in ARIA, not only in its border', () => {
    expect(components).toMatch(/aria-pressed=\{showLibrary\}/);
  });
});
