import { describe, expect, it } from 'vitest';

import { flattenAtRules, sources, withoutComments } from './stylesheetSource';

/**
 * Rules keep their own declarations (6.5 closure pass).
 *
 * This file exists because of one defect. 6.5 retired `.recents__empty`,
 * which shared a block with `.recents__meta`:
 *
 * ```css
 * .recents__meta,
 * .recents__empty {
 *   color: var(--colour-text-muted);
 * }
 * ```
 *
 * The deletion took the second selector, the closing brace and the blank
 * line, and left `.recents__meta,` sitting in front of the next rule's
 * comment. The selector was still in the stylesheet, so every existing
 * check passed — dead-class analysis, token analysis, the contrast
 * sweep — while the recent-documents metadata quietly lost its muted
 * colour and took on the page-number field's 5.5 rem box and right
 * alignment. The 6.5 acceptance audit measured it in a real window.
 *
 * The failure mode is specific and worth naming: **a selector survives, but
 * its declarations have been re-parented into an unrelated rule.** Two
 * independent tests catch it — one structural, one about the rule that was
 * actually damaged — and each is paired with a synthetic stylesheet
 * proving it fails when the fault is present.
 */

/** One `selector { body }` rule, as written. */
interface StyleRule {
  readonly selector: string;
  readonly body: string;
}

const stylesheets = (): readonly (readonly [string, string])[] => [
  ['tokens.css', sources.tokens],
  ['global.css', sources.global],
  ['reader.css', sources.reader],
];

/**
 * Selector lists that a comment interrupts.
 *
 * A comma followed by a comment is how the corruption looks in the source:
 * `.a, /* … *\/ .b { … }` is valid CSS and reads as two unrelated things
 * sharing one block. Writing it on purpose would be unkind to the next
 * reader; writing it by accident is the bug. Comments *before* a selector
 * list, which is how every rule in this codebase is documented, are
 * untouched by this — only a comment between a comma and the next
 * selector counts.
 */
const interruptedSelectorLists = (css: string): string[] =>
  [...css.matchAll(/([.#:[\w-][^{};]*),\s*\/\*/g)].map(
    (match) => (match[1] ?? '').trim().split('\n').pop()?.trim() ?? '',
  );

/** Every rule, with comments removed and media queries lifted. */
const rules = (css: string): StyleRule[] =>
  [...flattenAtRules(withoutComments(css)).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? '').trim().replace(/\s+/g, ' '),
    body: match[2] ?? '',
  }));

/** The rules whose selector list mentions one class. */
const rulesFor = (css: string, className: string): StyleRule[] =>
  rules(css).filter((rule) =>
    new RegExp(`(?:^|[\\s,>+~])\\.${className}(?![\\w-])`).test(rule.selector),
  );

/** The declarations one class receives, as `property` → `value`. */
const declarationsFor = (css: string, className: string): Map<string, string> => {
  const found = new Map<string, string>();

  for (const rule of rulesFor(css, className)) {
    for (const declaration of rule.body.split(';')) {
      const colon = declaration.indexOf(':');

      if (colon !== -1) {
        found.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
      }
    }
  }

  return found;
};

/** The stylesheet as it stood at `7de334e`, with the defect in place. */
const CORRUPTED = `
.recents__open {
  flex: 1;
}

.recents__meta,
/* CTL-4: wide enough for a five-digit page number without scrolling. */
.reader__page-input {
  width: 5.5rem;
  text-align: right;
}
`;

/** The same stylesheet, repaired. */
const REPAIRED = `
.recents__meta {
  color: var(--colour-text-muted);
}

/* CTL-4: wide enough for a five-digit page number without scrolling. */
.reader__page-input {
  width: 5.5rem;
  text-align: right;
}
`;

describe('no rule has been re-parented into another (6.5 closure)', () => {
  it('leaves no selector list interrupted by a comment', () => {
    const found = stylesheets().flatMap(([name, css]) =>
      interruptedSelectorLists(css).map((selector) => `${name}: ${selector}`),
    );

    expect(found).toStrictEqual([]);
  });

  it('finds that interruption in the stylesheet that shipped with it', () => {
    // Without this the test above could pass because the pattern never
    // matches anything, rather than because the stylesheets are sound.
    expect(interruptedSelectorLists(CORRUPTED)).toStrictEqual(['.recents__meta']);
    expect(interruptedSelectorLists(REPAIRED)).toStrictEqual([]);
  });
});

describe('the recent-documents metadata keeps its own declarations', () => {
  const metaDeclarations = (): Map<string, string> =>
    declarationsFor(sources.reader, 'recents__meta');

  it('is secondary text, as it was before 6.5', () => {
    expect(metaDeclarations().get('color')).toBe('var(--colour-text-muted)');
  });

  it('takes no geometry from the page-number field it sits above in the file', () => {
    const declarations = metaDeclarations();

    // The specific symptoms of the defect: a 5.5 rem box and right
    // alignment on a line of prose that is as long as the document's
    // reading position happens to make it.
    expect(declarations.has('width')).toBe(false);
    expect(declarations.has('text-align')).toBe(false);
  });

  it('is never declared in the same rule as the page-number field', () => {
    const shared = rulesFor(sources.reader, 'recents__meta').filter((rule) =>
      rule.selector.includes('.reader__page-input'),
    );

    expect(shared).toStrictEqual([]);
  });

  it('reads the broken stylesheet as broken and the repaired one as sound', () => {
    expect(declarationsFor(CORRUPTED, 'recents__meta').get('color')).toBeUndefined();
    expect(declarationsFor(CORRUPTED, 'recents__meta').get('width')).toBe('5.5rem');
    expect(declarationsFor(REPAIRED, 'recents__meta').get('color')).toBe(
      'var(--colour-text-muted)',
    );
    expect(declarationsFor(REPAIRED, 'recents__meta').has('width')).toBe(false);
  });
});
