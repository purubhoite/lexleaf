/**
 * ADR-029 typography floor for failure reporting (Milestone 6.1 remediation).
 *
 * ADR-029 states the rule positively: nothing that reports a failure is set
 * below `--text-sm`. A message a reader only sees when something has gone
 * wrong is the worst possible place to save a pixel, so the floor is a
 * property of the stylesheet, not of three selectors that happen to comply
 * today.
 *
 * The test therefore works by classification, not by enumeration. It finds
 * every chrome rule that reports a failure — by the failure vocabulary in its
 * selector, or by painting its text with the failure palette — resolves
 * whatever text size that rule declares (token, literal, or `font:`
 * shorthand) and compares it with the floor. A new error style that is too
 * small fails without anyone remembering to add it here, and the analyser is
 * exercised against known-bad CSS below so the suite cannot pass by matching
 * nothing.
 *
 * It is a source test for the same reasons as its neighbours: Vitest stubs
 * CSS imports, and the renderer may not read files.
 */

import { describe, expect, it } from 'vitest';

import {
  flattenAtRules,
  sources,
  splitDocumentSurface,
  tokenValue,
  withoutComments,
} from './stylesheetSource';

/** The floor ADR-029 names, in rem. */
const FLOOR_TOKEN = '--text-sm';

/** Colours whose whole purpose is to report that something went wrong. */
const FAILURE_PALETTE = ['--colour-danger', '--colour-problem'];

/**
 * The vocabulary this codebase uses for failure in a class name. `cause`
 * is kept in the list although no rule carries it today: `.reader__cause`
 * reported why an open failed until the 6.5 closure pass removed the
 * engine wording from the failure screen, and the word is the obvious one
 * to reach for again.
 */
const FAILURE_VOCABULARY = /(?:error|failed|failure|invalid|cause|problem|warning|danger)/i;

/** Browsers resolve rem against a 16px root; nothing here changes that. */
const ROOT_PX = 16;

interface StyleRule {
  readonly selector: string;
  readonly body: string;
}

/**
 * The chrome, with the document surface and the comments removed, and with
 * the 6.4 media queries flattened so that a rule inside one is judged like
 * any other rule rather than disappearing behind a second level of braces.
 */
const chrome = (): string => {
  const reader = splitDocumentSurface(sources.reader);

  return flattenAtRules(withoutComments(`${sources.global}\n${reader.chrome}`));
};

/** Flat `selector { body }` rules, after `flattenAtRules` has lifted them. */
const styleRules = (css: string): StyleRule[] =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? '').trim().replace(/\s+/g, ' '),
    body: match[2] ?? '',
  }));

/** Every value given to one property in a rule body. */
const valuesOf = (body: string, property: string): string[] =>
  [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${property}\\s*:([^;}]+)`, 'g'))].map((match) =>
    (match[1] ?? '').trim(),
  );

/**
 * A rule reports a failure when it is named for one, or when it paints its
 * own text with the failure palette. Painting a *border* with the problem
 * colour — as the library toggle does — is emphasis, not a message, so only
 * `color` counts.
 */
const reportsFailure = (rule: StyleRule): boolean =>
  FAILURE_VOCABULARY.test(rule.selector) ||
  valuesOf(rule.body, 'color').some((value) =>
    FAILURE_PALETTE.some((colour) => value.includes(`var(${colour})`)),
  );

/**
 * The text sizes a rule declares, whether written as `font-size` or hidden in
 * the `font` shorthand. The shorthand is read because it is the obvious way
 * for a size to re-enter the stylesheet unnoticed.
 */
const declaredSizes = (body: string): string[] => {
  const shorthand = [...body.matchAll(/(?:^|[;{])\s*font\s*:([^;}]+)/g)]
    .map(
      (match) =>
        /(?:^|[\s/])((?:var\(--[\w-]+\))|(?:[\d.]+[a-z%]*))(?=[\s/]|$)/.exec(match[1] ?? '')?.[1],
    )
    .filter((size): size is string => size !== undefined);

  return [...valuesOf(body, 'font-size'), ...shorthand];
};

/**
 * A declared size in rem, or `null` when it cannot be resolved — an unknown
 * unit is treated as a failure to prove the floor, never as a pass.
 */
const toRem = (value: string): number | null => {
  const token = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());

  if (token?.[1] !== undefined) {
    try {
      return toRem(tokenValue(token[1]));
    } catch {
      return null;
    }
  }

  const literal = /^([\d.]+)(rem|px)$/.exec(value.trim());

  if (literal === null) {
    return null;
  }

  const size = Number.parseFloat(literal[1] ?? '');

  return literal[2] === 'px' ? size / ROOT_PX : size;
};

interface Offence {
  readonly selector: string;
  readonly size: string;
}

/** Every failure-reporting rule in `css` whose text is below the floor. */
const belowFloor = (css: string, floorRem: number): Offence[] =>
  styleRules(withoutComments(css))
    .filter(reportsFailure)
    .flatMap((rule) =>
      declaredSizes(rule.body)
        .filter((size) => {
          const rem = toRem(size);

          return rem === null || rem < floorRem;
        })
        .map((size) => ({ selector: rule.selector, size })),
    );

const floorRem = toRem(tokenValue(FLOOR_TOKEN));

describe('ADR-029: failure reporting is never set below --text-sm', () => {
  it('resolves the floor from the token layer rather than hard-coding it', () => {
    expect(floorRem).not.toBeNull();
    expect(tokenValue(FLOOR_TOKEN)).toMatch(/^[\d.]+rem$/);
  });

  it('finds failure-reporting rules to judge, so the rule cannot pass vacuously', () => {
    const failureRules = styleRules(chrome()).filter(reportsFailure);
    const sized = failureRules.filter((rule) => declaredSizes(rule.body).length > 0);

    expect(failureRules.length).toBeGreaterThanOrEqual(3);
    expect(sized.length).toBeGreaterThanOrEqual(3);
  });

  it('sets no failure message below the floor anywhere in the chrome', () => {
    expect(belowFloor(chrome(), floorRem ?? 0)).toEqual([]);
  });

  it('judges a failure message that hides inside a media query', () => {
    // 6.4 gave the chrome its first media queries. Before `flattenAtRules`
    // every analyser here read flat text, so a rule nested in one was
    // simply not seen: this is the regression that would have let a narrow
    // window shrink an error message below the floor unnoticed.
    const nested = '@media (max-width: 820px) { .thing__error { font-size: var(--text-xs); } }';

    expect(belowFloor(nested, floorRem ?? 0)).toStrictEqual([
      { selector: '.thing__error', size: 'var(--text-xs)' },
    ]);
  });

  it('leaves no at-rule block unflattened in the chrome it judges', () => {
    // The analysers below parse `selector { body }` and nothing deeper, so
    // the invariant is not "there are no at-rules" any more — it is that
    // none survive into the text they read.
    expect(chrome()).not.toMatch(/@(?:media|supports|layer|container|scope)/);
    expect(sources.reader).toMatch(/@media/);
  });

  describe('the analyser detects a regression', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['a smaller token', '.thing__error { font-size: var(--text-xs); }'],
      ['a rem literal', '.thing__failure { font-size: 0.75rem; }'],
      ['a px literal', '.load-cause { font-size: 11px; }'],
      ['the font shorthand', '.thing__error { font: 12px/1.4 sans-serif; }'],
      ['an unresolvable unit', '.thing__error { font-size: 80%; }'],
      ['an undefined token', '.thing__error { font-size: var(--text-tiny); }'],
      [
        'a rule named innocently but painted with the failure palette',
        '.popup__note { color: var(--colour-danger); font-size: var(--text-xs); }',
      ],
    ];

    it.each(cases)('catches %s', (_name, css) => {
      expect(belowFloor(css, floorRem ?? 0)).toHaveLength(1);
    });

    it('accepts the same rules at or above the floor', () => {
      const compliant = `
        .thing__error { font-size: var(--text-sm); }
        .thing__failure { font-size: 1rem; }
        .load-cause { font: 16px/1.4 sans-serif; }
        .popup__note { color: var(--colour-danger); font-size: var(--text-base); }
      `;

      expect(belowFloor(compliant, floorRem ?? 0)).toEqual([]);
    });

    it('does not judge rules that report nothing, including problem-coloured borders', () => {
      const unrelated = `
        .shell__toggle[aria-pressed='true'] { border-color: var(--colour-problem); }
        .dictionary-popup__attribution { font-size: var(--text-xs); }
      `;

      expect(belowFloor(unrelated, floorRem ?? 0)).toEqual([]);
    });
  });
});
