import { describe, expect, it } from 'vitest';

import {
  componentSources,
  flattenAtRules,
  selectedClasses,
  sources,
  splitDocumentSurface,
  tokenValue,
  withoutComments,
} from './stylesheetSource';

/**
 * The shared state presentation, judged from the stylesheet
 * (6.5, Parts 1 and 6).
 *
 * Three things are worth a stylesheet test rather than a DOM test:
 *
 * - a failure must be distinguishable without colour (A11Y-14, ST-8), so
 *   `.message--problem` has to carry something a greyscale screen or a
 *   forced-colours mode still shows;
 * - the four idioms 6.4 used for the same job must be gone, not merely
 *   unused, or the next change will pick one of them up again;
 * - the shared rule must stay inside the token system, because that is
 *   what keeps the failure text at or above the 6.1 size floor.
 */

const css = (): string =>
  withoutComments(
    flattenAtRules([sources.global, splitDocumentSurface(sources.reader).chrome].join('\n')),
  );

/** The declarations of one rule, by exact selector. */
const rule = (selector: string): ReadonlyMap<string, string> => {
  const pattern = new RegExp(`(?:^|})\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm');
  const match = pattern.exec(css());

  if (match?.[1] === undefined) {
    throw new Error(`No rule for ${selector}.`);
  }

  return new Map(
    match[1]
      .split(';')
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration.length > 0)
      .map((declaration) => {
        const colon = declaration.indexOf(':');

        return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()] as const;
      }),
  );
};

/**
 * Every class name a renderer source writes into a `className`.
 *
 * Deliberately not every string in the renderer: `role="status"` would
 * otherwise read as the retired `.status` class and the check below could
 * never fail. The shared component composes its own names from a map, so
 * those are checked separately, by name, in the last test here.
 */
const renderedClasses = (): ReadonlySet<string> => {
  const source = withoutComments(componentSources()).replace(/^\s*\/\/.*$/gm, '');
  const values = [...source.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)].map(
    (match) => `${match[1] ?? ''} ${match[2] ?? ''}`,
  );

  return new Set(
    values
      .join(' ')
      .split(/[^A-Za-z0-9_-]+/)
      .filter((name) => name.length > 0),
  );
};

/**
 * A compound selector reduced to the classes an element must and must not
 * carry for the rule to apply.
 *
 * Only `.a`, `.a.b` and `:not(.c)` are modelled, because that is all the
 * cascade below the shared message uses; anything else throws rather than
 * being skipped, so the analysis cannot quietly stop seeing a rule that
 * starts repainting a failure.
 */
interface Compound {
  readonly required: readonly string[];
  readonly forbidden: readonly string[];
}

const SIMPLE = /^(?:\.[A-Za-z][\w-]*|:not\(\.[A-Za-z][\w-]*\))+$/;

const parseCompound = (part: string): Compound | null => {
  const selector = part.trim();

  if (!SIMPLE.test(selector)) {
    return null;
  }

  const forbidden = [...selector.matchAll(/:not\(\.([A-Za-z][\w-]*)\)/g)].map(
    (match) => match[1] ?? '',
  );
  const required = [...selector.replace(/:not\([^)]*\)/g, '').matchAll(/\.([A-Za-z][\w-]*)/g)].map(
    (match) => match[1] ?? '',
  );

  return { required, forbidden };
};

/**
 * The colour an element with exactly these classes ends up with.
 *
 * Every rule involved has one-class specificity, so source order decides;
 * `null` means nothing in the chrome colours it.
 */
const resolvedColour = (css: string, classes: readonly string[]): string | null => {
  const carried = new Set(classes);
  let winner: string | null = null;

  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const parts = (match[1] ?? '').split(',');
    const body = match[2] ?? '';
    const colour = /(?:^|[;{])\s*color\s*:([^;}]+)/.exec(body);

    if (colour === null) {
      continue;
    }

    for (const part of parts) {
      const compound = parseCompound(part);

      if (compound === null) {
        if (classes.some((name) => part.includes(`.${name}`))) {
          throw new Error(`Unmodelled selector for a message composition: ${part.trim()}`);
        }

        continue;
      }

      const applies =
        compound.required.every((name) => carried.has(name)) &&
        !compound.forbidden.some((name) => carried.has(name));

      if (applies) {
        winner = (colour[1] ?? '').trim();
      }
    }
  }

  return winner;
};

/** The `className` a renderer hands a `<Message kind="problem">`. */
const problemCompositions = (): string[] => {
  const tags = [...componentSources().matchAll(/<Message\b[^>]*>/g)].map((match) => match[0]);

  return [
    ...new Set(
      tags
        .filter((tag) => tag.includes('kind="problem"'))
        .flatMap((tag) => /className="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/) ?? []),
    ),
  ].filter((name) => name.length > 0);
};

const RETIRED = [
  '.status',
  '.status--problem',
  '.library__status',
  '.library__status--problem',
  '.recents__empty',
  '.word__empty',
  '.reader__message',
];

describe('a failure is not told apart by colour alone (A11Y-14, ST-8)', () => {
  it('gives the problem message a second, non-colour signal', () => {
    const declarations = rule('.message--problem');
    const nonColour = [...declarations.keys()].filter((property) => property !== 'color');

    expect(nonColour.length).toBeGreaterThan(0);
  });

  it('draws that signal as a border, which survives a greyscale screen', () => {
    const declarations = rule('.message--problem');

    expect(declarations.get('border-inline-start')).toBeDefined();
    expect(declarations.get('padding-inline-start')).toBeDefined();
  });

  it('indents the text by at least as much as the border it sits behind', () => {
    const declarations = rule('.message--problem');
    const border = declarations.get('border-inline-start') ?? '';
    const padding = declarations.get('padding-inline-start') ?? '';

    // A border with no matching indent puts the rule through the first
    // letter. Both come from tokens, so this is a check that the pair
    // was thought about, not a pixel assertion.
    expect(border).toContain('var(--border-width)');
    expect(padding).toMatch(/^var\(--space-/);
  });
});

describe('the shared message stays inside the token system', () => {
  it('sizes itself from a token at or above the 6.1 floor', () => {
    const size = rule('.message').get('font-size') ?? '';

    expect(size).toBe('var(--text-sm)');
    expect(Number.parseFloat(tokenValue('--text-sm'))).toBeGreaterThanOrEqual(0.875);
  });

  it('keeps the two-line specification copy readable as two lines', () => {
    // PRODUCT_SPEC § 20 writes the open failure as two sentences on two
    // lines; collapsing the newline would silently rewrite the copy.
    expect(rule('.message').get('white-space')).toBe('pre-line');
  });

  it('takes its colours from tokens, never from a literal', () => {
    for (const selector of ['.message', '.message--problem']) {
      const colour = rule(selector).get('color');

      expect(colour === undefined || colour.startsWith('var(--colour-')).toBe(true);
    }
  });

  it('introduces no motion, which belongs to 6.7', () => {
    for (const selector of ['.message', '.message--problem']) {
      const declarations = [...rule(selector).keys()];

      expect(declarations.filter((name) => /transition|animation/.test(name))).toStrictEqual([]);
    }
  });
});

describe('the idioms it replaced are gone, not just unused', () => {
  it('leaves no rule behind for any of them', () => {
    const selected = new Set(selectedClasses(css()).map((name) => `.${name}`));
    const survivors = RETIRED.filter((selector) => selected.has(selector));

    expect(survivors).toStrictEqual([]);
  });

  it('leaves no renderer still asking for one of them', () => {
    const survivors = RETIRED.filter((selector) => renderedClasses().has(selector.slice(1)));

    expect(survivors).toStrictEqual([]);
  });

  it('can tell a class from a role, so the check above can fail', () => {
    // `role="status"` is not the class `.status`. If the two were
    // conflated, the assertion above would be unfalsifiable — and the
    // renderer does contain `role="status"`.
    expect(componentSources()).toContain('role="status"');
    expect(renderedClasses().has('status')).toBe(false);
    expect(renderedClasses().has('library__problem')).toBe(true);
  });

  it('did not simply rename one class into another: the shared rule is used', () => {
    const renderer = componentSources();

    expect(renderer).toContain('message message--problem');
    expect(renderer).toContain('message message--empty');
  });
});

describe('a surface may place a problem message, never recolour it (C6)', () => {
  it('leaves the failure foreground on a message that stands alone', () => {
    expect(resolvedColour(css(), ['message', 'message--problem'])).toBe('var(--colour-danger)');
  });

  it('leaves it there for every class a renderer composes with it', () => {
    const composed = problemCompositions();

    // The popup's failure line is the one the 6.5 acceptance audit found
    // repainted muted by the surface class it borrows for layout.
    expect(composed).toContain('dictionary-popup__status');

    for (const name of composed) {
      expect({
        name,
        colour: resolvedColour(css(), ['message', 'message--problem', name]),
      }).toStrictEqual({ name, colour: 'var(--colour-danger)' });
    }
  });

  it('still lets a surface colour the node when it is not a message', () => {
    // The popup's own status line is not a `Message`; it keeps the muted
    // colour, which is why the rule could not simply be deleted.
    expect(resolvedColour(css(), ['dictionary-popup__status'])).toBe('var(--colour-text-muted)');
  });

  it('notices when a surface does repaint one', () => {
    const repainted = [
      '.message--problem { color: var(--colour-danger); }',
      '.surface__note { color: var(--colour-text-muted); }',
    ].join('\n');

    expect(resolvedColour(repainted, ['message', 'message--problem', 'surface__note'])).toBe(
      'var(--colour-text-muted)',
    );
  });

  it('refuses to judge a selector it cannot model', () => {
    const exotic = '.panel > .message--problem span { color: var(--colour-text); }';

    expect(() => resolvedColour(exotic, ['message', 'message--problem'])).toThrow(
      /Unmodelled selector/,
    );
  });
});
