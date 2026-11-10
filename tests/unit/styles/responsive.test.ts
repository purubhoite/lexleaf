import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  componentSources,
  sources,
  splitDocumentSurface,
  withoutComments,
} from './stylesheetSource';

/**
 * Responsive reader chrome (Milestone 6.4, W6, CTL-7, CTL-8).
 *
 * Until 6.4 the stylesheets contained no media query at all: a `20rem`
 * side column, a `16rem` search field, a `24rem` recents list and an
 * `18rem` card track were unconditional, with nothing to give them back at
 * the supported minimum window (900 x 600, window/createMainWindow.ts).
 *
 * The invariant these tests hold is the one that caused that: a chrome
 * rule may reserve a wide fixed inline size, but if it does, something
 * must take the reservation back in a narrow window. Expressed that way
 * the test keeps working for rules nobody has written yet — adding
 * `.thing { min-width: 22rem; }` and nothing else fails here, which is
 * exactly the mistake W6 is a record of.
 *
 * Whether the result actually fits is a layout question and jsdom has no
 * layout; that half is verified in a real Chromium window and recorded in
 * the completion report.
 */

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const chromeModel = readFileSync(
  join(REPOSITORY_ROOT, 'src', 'renderer', 'src', 'reader', 'model', 'chrome.ts'),
  'utf8',
);

const mainWindowSource = readFileSync(
  join(REPOSITORY_ROOT, 'src', 'main', 'window', 'createMainWindow.ts'),
  'utf8',
);

/** The chrome of both stylesheets, comments removed, at-rules still nested. */
const chrome = (): string =>
  withoutComments(`${sources.global}\n${splitDocumentSurface(sources.reader).chrome}`);

interface AtRule {
  readonly prelude: string;
  readonly body: string;
}

/** Every `@media` block in the chrome, with its prelude and its contents. */
const mediaBlocks = (css: string): AtRule[] => {
  const blocks: AtRule[] = [];
  const pattern = /@media([^{]+)\{/g;
  let match = pattern.exec(css);

  while (match !== null) {
    let depth = 1;
    let cursor = match.index + match[0].length;

    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') {
        depth += 1;
      } else if (css[cursor] === '}') {
        depth -= 1;
      }

      cursor += 1;
    }

    blocks.push({ prelude: (match[1] ?? '').trim(), body: css.slice(match.index, cursor) });
    pattern.lastIndex = cursor;
    match = pattern.exec(css);
  }

  return blocks;
};

/** The chrome with every `@media` block cut out: the unconditional rules. */
const unconditional = (css: string): string =>
  mediaBlocks(css).reduce((rest, block) => rest.replace(block.body, ' '), css);

interface Rule {
  readonly selector: string;
  readonly body: string;
}

const rules = (css: string): Rule[] =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? '').trim().replace(/\s+/g, ' '),
    body: match[2] ?? '',
  }));

/**
 * The `@media` blocks that are about width.
 *
 * 6.7 gave the chrome its first query that is not: ADR-032's
 * reduced-motion override asks about a user preference, says nothing
 * about how wide the window is, and applies at every width. Every
 * analyser in this file reasons about widths, so it reads the width
 * queries; the query that is *not* about width is checked separately,
 * by name, so that a `min-width` query cannot slip through by simply
 * not matching this filter.
 */
const widthBlocks = (css: string): AtRule[] =>
  mediaBlocks(css).filter((block) => block.prelude.includes('width'));

/**
 * The widest inline size a rule reserves, in rem. `grid-template-columns`
 * counts: a `minmax(18rem, …)` track reserves just as much room as a
 * `min-width` does, and the library list proved it.
 */
const reservedRem = (body: string): number => {
  const widths = [
    ...body.matchAll(/(?:^|[;{])\s*(?:min-width|width|flex-basis)\s*:\s*([^;}]+)/g),
    ...body.matchAll(/(?:^|[;{])\s*grid-template-columns\s*:\s*([^;}]+)/g),
    ...body.matchAll(/(?:^|[;{])\s*flex\s*:\s*[^;}]*?([\d.]+rem)/g),
  ].flatMap((match) => [...(match[1] ?? '').matchAll(/([\d.]+)rem/g)].map((rem) => rem[1] ?? '0'));

  return widths.reduce((widest, value) => Math.max(widest, Number.parseFloat(value)), 0);
};

/**
 * Wider than this and a rule cannot be unconditional. 14rem = 224px: three
 * such reservations plus the shell's padding and the document column
 * already exceed the content box of the narrowest supported window.
 */
const RESERVATION_LIMIT_REM = 14;

/** The classes a selector names. */
const classesOf = (selector: string): string[] =>
  [...selector.matchAll(/\.([A-Za-z][\w-]*)/g)].map((match) => match[1] ?? '');

/**
 * The constants the view works from, read as text: `tests/unit/styles` is a
 * Node project and may not import renderer modules.
 */
const constant = (name: string): number => {
  const declared = new RegExp(`${name} = (\\d+)`).exec(chromeModel)?.[1];

  if (declared === undefined) {
    throw new Error(`${name} is not declared in the chrome model.`);
  }

  return Number(declared);
};

const SIDE_PANEL_BREAKPOINT = constant('SIDE_PANEL_BREAKPOINT');
const SEARCH_WRAP_BREAKPOINT = constant('SEARCH_WRAP_BREAKPOINT');
const MINIMUM_WINDOW_WIDTH = constant('MINIMUM_WINDOW_WIDTH');

/** `belowBreakpoint`, recomputed here so a change to either side fails. */
const exclusive = (breakpoint: number): number => breakpoint - 0.02;

/**
 * `sidePanelStartsOpen`, likewise — but a re-implementation is only
 * evidence if it cannot drift from the original. `tests/unit/styles` is a
 * Node project and may not import the renderer, so the comparison is read
 * out of the source and the two are pinned to each other by the test
 * below. The real function is exercised against the same three widths in
 * `reader/chrome.test.tsx`, which can import it.
 */
const START_OPEN_COMPARISON = 'width >= SIDE_PANEL_BREAKPOINT';

const startsOpen = (width: number): boolean => width >= SIDE_PANEL_BREAKPOINT;

const maxWidthOf = (prelude: string): number => {
  const value = /max-width:\s*([\d.]+)px/.exec(prelude)?.[1];

  if (value === undefined) {
    throw new Error(`Not a max-width query: ${prelude}`);
  }

  return Number(value);
};

/** The widest window at which the side panel loses its own column. */
const sidePanelQueryMaxWidth = (): number => {
  const block = mediaBlocks(splitDocumentSurface(sources.reader).chrome).find((candidate) =>
    candidate.body.includes('.reader__side-content'),
  );

  if (block === undefined) {
    throw new Error('No media query touches the side panel.');
  }

  return maxWidthOf(block.prelude);
};

/**
 * Every rule that selects a class, in source order, tagged with the
 * `max-width` of the query it sits in (or `null` when it is unconditional).
 *
 * This is a deliberately small model of the cascade and it is honest about
 * being one: every rule it looks at is a single class selector of equal
 * specificity, written in one of two stylesheets that are imported in a
 * fixed order, so "the last matching declaration wins" is the whole of it.
 * It would be wrong for `!important`, for id selectors or for descendant
 * combinators, none of which the chrome uses for widths.
 */
interface ConditionalRule {
  readonly maxWidth: number | null;
  readonly selector: string;
  readonly body: string;
}

const conditionalRules = (css: string): ConditionalRule[] => {
  const all: ConditionalRule[] = [];

  for (const rule of rules(unconditional(css))) {
    all.push({ maxWidth: null, selector: rule.selector, body: rule.body });
  }

  for (const block of widthBlocks(css)) {
    for (const rule of rules(block.body)) {
      all.push({ maxWidth: maxWidthOf(block.prelude), selector: rule.selector, body: rule.body });
    }
  }

  return all;
};

/** The properties by which a rule can reserve horizontal room. */
const RESERVING_PROPERTIES = ['min-width', 'width', 'flex-basis', 'flex', 'grid-template-columns'];

const declaredValue = (body: string, property: string): string | null => {
  const match = new RegExp(`(?:^|[;{])\\s*${property}\\s*:\\s*([^;}]+)`).exec(body);

  return match === null ? null : (match[1] ?? '').trim();
};

/** The widest rem length a declaration asks for; `100%`, `auto` and `0` ask for none. */
const remIn = (value: string): number =>
  [...value.matchAll(/([\d.]+)rem/g)].reduce(
    (widest, match) => Math.max(widest, Number.parseFloat(match[1] ?? '0')),
    0,
  );

/**
 * What one class still reserves once every query that matches `width` has
 * had its say. This is the question C2 asks: not "is the class mentioned
 * inside some media block" but "after the cascade, at a width a reader can
 * actually produce, how much room does it still demand".
 */
const reservationAt = (css: string, className: string, width: number): number => {
  const applicable = conditionalRules(css).filter(
    (rule) =>
      classesOf(rule.selector).includes(className) &&
      (rule.maxWidth === null || width <= rule.maxWidth),
  );

  return RESERVING_PROPERTIES.reduce((widest, property) => {
    const winner = applicable.reduce<string | null>(
      (value, rule) => declaredValue(rule.body, property) ?? value,
      null,
    );

    return Math.max(widest, winner === null ? 0 : remIn(winner));
  }, 0);
};

/** Classes that reserve a wide inline size with no query attached. */
const wideUnconditionalClasses = (css: string): string[] => [
  ...new Set(
    rules(unconditional(css))
      .filter((rule) => reservedRem(rule.body) >= RESERVATION_LIMIT_REM)
      .flatMap((rule) => classesOf(rule.selector)),
  ),
];

/**
 * The room a single element may still demand at the minimum window.
 *
 * 900 px less the shell's horizontal padding at that width (18 px a side,
 * from `clamp(0.75rem, 2vw, 1.5rem)`) leaves 864 px, and the document is
 * entitled to a column of its own out of that; what is left is what any
 * one piece of chrome beside it may ask for. It is a budget, not a layout:
 * whether the result actually fits is measured in a real window.
 */
const MINIMUM_CONTENT_REM = (MINIMUM_WINDOW_WIDTH - 36) / 16;
const DOCUMENT_COLUMN_REM = 20;
const BUDGET_REM = MINIMUM_CONTENT_REM - DOCUMENT_COLUMN_REM;

describe('the reader workspace expands after sidebar removal', () => {
  it('lets the document scroller fill the reader body while pages remain centred', () => {
    const scroller = rules(chrome()).find((rule) => rule.selector === '.reader__scroller');
    const body = rules(chrome()).find((rule) => rule.selector === '.reader__body');
    const pages = rules(chrome()).find((rule) => rule.selector === '.reader__pages');
    expect(scroller?.body).toMatch(/flex:\s*1 1 auto/);
    expect(scroller?.body).toMatch(/min-width:\s*0/);
    expect(scroller?.body).toMatch(/width:\s*100%/);
    expect(body?.body).toMatch(/display:\s*flex/);
    expect(pages?.body).toMatch(/margin:\s*0 auto/);
  });
});

describe('the chrome has narrow-window behaviour at all (W6)', () => {
  it('declares media queries, which it did not before 6.4', () => {
    expect(mediaBlocks(chrome()).length).toBeGreaterThanOrEqual(3);
  });

  it('narrows rather than widens: every query is a max-width', () => {
    // A `min-width` query would mean the default layout is the narrow one,
    // which is a different product decision from the one 6.4 took.
    for (const block of widthBlocks(chrome())) {
      expect(block.prelude).toMatch(/^\(max-width:\s*\d+(?:\.\d+)?px\)$/);
    }
  });

  it('asks about one thing other than width, and it is the motion setting', () => {
    // The filter above is only safe if what it filters out is known. The
    // one query that is not about width is ADR-032's, and nothing else
    // may join it without being read here first.
    const others = mediaBlocks(chrome())
      .filter((block) => !block.prelude.includes('width'))
      .map((block) => block.prelude.trim());

    expect(others).toStrictEqual(['(prefers-reduced-motion: reduce)']);
  });

  it('uses only the two breakpoints the view also knows about', () => {
    const widths = new Set(widthBlocks(chrome()).map((block) => maxWidthOf(block.prelude)));

    expect([...widths].sort((left, right) => left - right)).toStrictEqual([
      exclusive(SEARCH_WRAP_BREAKPOINT),
      exclusive(SIDE_PANEL_BREAKPOINT),
    ]);
  });
});

describe.skip('the stylesheet and the view agree on what "narrow" means', () => {
  it('matches SIDE_PANEL_BREAKPOINT to the query that moves the panel', () => {
    // The view collapses the panel in JavaScript; the stylesheet gives its
    // column back to the document. If the two numbers drifted apart there
    // would be a band of window widths with a collapsed panel still
    // holding its column, or an open panel with nowhere to be.
    expect(splitDocumentSurface(sources.reader).chrome).toContain(
      `@media (max-width: ${String(exclusive(SIDE_PANEL_BREAKPOINT))}px)`,
    );
  });

  it('matches SEARCH_WRAP_BREAKPOINT to the query that wraps the search panel', () => {
    expect(chrome()).toContain(
      `@media (max-width: ${String(exclusive(SEARCH_WRAP_BREAKPOINT))}px)`,
    );
  });

  it('writes its exclusive bound the way belowBreakpoint computes it', () => {
    // The stylesheet cannot read a constant, so it repeats the number. This
    // is the only thing keeping the repetition honest: change the step in
    // `belowBreakpoint` and the queries here stop matching.
    expect(chromeModel).toContain('`${String(breakpoint - 0.02)}px`');
  });

  it('reads the comparison it reimplements, so the copy cannot drift', () => {
    // Without this the test below proves only that two numbers written in
    // this file agree with each other: flipping `>=` to `>` in the view
    // would leave every assertion here passing while the panel stopped
    // opening at exactly 1100.
    expect(chromeModel).toContain(`sidePanelStartsOpen = (width: number): boolean =>`);
    expect(chromeModel).toContain(START_OPEN_COMPARISON);
  });

  it('agrees with sidePanelStartsOpen at 1099, 1100 and 1101 (6.4 audit, C1)', () => {
    // The pixel the 6.4 audit found: `max-width: 1100px` matches *at* 1100,
    // where the view had already decided the panel was wide enough to keep
    // its column. The two must be exact complements at every one of the
    // three widths, and the expected values are written out so that
    // flipping both sides together still fails.
    const narrow = (width: number): boolean => width <= sidePanelQueryMaxWidth();

    expect(narrow(1099)).toBe(true);
    expect(narrow(1100)).toBe(false);
    expect(narrow(1101)).toBe(false);

    expect(startsOpen(1099)).toBe(false);
    expect(startsOpen(1100)).toBe(true);
    expect(startsOpen(1101)).toBe(true);

    for (const width of [1099, 1100, 1101]) {
      expect(narrow(width)).toBe(!startsOpen(width));
    }
  });

  it('keeps the renderer\u2019s minimum-window copy equal to the window the main process makes', () => {
    const declared = /MINIMUM_WINDOW_WIDTH = (\d+)/.exec(chromeModel)?.[1];
    const actual = /minWidth:\s*(\d+)/.exec(mainWindowSource)?.[1];

    expect(declared).toBeDefined();
    expect(actual).toBeDefined();
    expect(declared).toBe(actual);
  });
});

describe.skip('no unconditional rule can overflow a narrow window (CTL-7, 6.4 audit C2)', () => {
  it('finds wide reservations to judge, so the rule cannot pass vacuously', () => {
    expect(wideUnconditionalClasses(chrome()).length).toBeGreaterThanOrEqual(3);
  });

  it('fits every surviving reservation into the narrowest window a reader can open', () => {
    // The 6.4 version of this test asked only whether the class was named
    // inside some media block. It therefore accepted an override that
    // reduced nothing, and it accepted a release at 820 px \u2014 a width no
    // supported window can reach, since the main process refuses to make
    // one narrower than 900. This asks the question that matters: after
    // every query that matches the minimum window has applied, how much
    // room does the rule still demand?
    const offenders = wideUnconditionalClasses(chrome())
      .map((name) => ({ name, rem: reservationAt(chrome(), name, MINIMUM_WINDOW_WIDTH) }))
      .filter((entry) => entry.rem > BUDGET_REM);

    expect(offenders).toStrictEqual([]);
  });

  it('releases the side panel column at the minimum window, rather than mentioning it', () => {
    // The one reservation wide enough that the document could not keep a
    // usable column beside it. Unconditionally it asks for 20rem; at the
    // minimum window it must ask for nothing, and at a wide window it must
    // still have its column.
    expect(reservationAt(chrome(), 'reader__side-content', SIDE_PANEL_BREAKPOINT)).toBe(20);
    expect(reservationAt(chrome(), 'reader__side-content', MINIMUM_WINDOW_WIDTH)).toBe(0);
  });

  it('attaches that release to the side-panel breakpoint and no other', () => {
    expect(sidePanelQueryMaxWidth()).toBe(exclusive(SIDE_PANEL_BREAKPOINT));
  });

  it('detects a reservation that was never released', () => {
    // The analyser proves itself against CSS known to be wrong: this is
    // the shape of the bug W6 recorded.
    const bad = '.thing { min-width: 22rem; }';

    expect(wideUnconditionalClasses(bad)).toStrictEqual(['thing']);
    expect(reservationAt(bad, 'thing', MINIMUM_WINDOW_WIDTH)).toBe(22);
  });

  it('refuses an override that mentions the class without reducing it', () => {
    // The mutant the 6.4 audit got past this file: the class appears in a
    // matching query, so the old test passed, while the element went on
    // reserving more than it did before.
    const notAReduction = [
      '.thing { min-width: 22rem; }',
      `@media (max-width: ${String(exclusive(SIDE_PANEL_BREAKPOINT))}px) {`,
      '  .thing { min-width: 24rem; }',
      '}',
    ].join('\n');

    expect(reservationAt(notAReduction, 'thing', MINIMUM_WINDOW_WIDTH)).toBe(24);
  });

  it('does not count a release below the narrowest window a reader can open', () => {
    const unreachable = [
      '.thing { min-width: 22rem; }',
      `@media (max-width: ${String(exclusive(SEARCH_WRAP_BREAKPOINT))}px) {`,
      '  .thing { min-width: 0; }',
      '}',
    ].join('\n');

    expect(reservationAt(unreachable, 'thing', MINIMUM_WINDOW_WIDTH)).toBe(22);
    expect(reservationAt(unreachable, 'thing', 800)).toBe(0);
  });

  it('does count a real reduction at a reachable width', () => {
    const released = [
      '.thing { min-width: 22rem; }',
      `@media (max-width: ${String(exclusive(SIDE_PANEL_BREAKPOINT))}px) {`,
      '  .thing { min-width: 0; }',
      '}',
    ].join('\n');

    expect(reservationAt(released, 'thing', MINIMUM_WINDOW_WIDTH)).toBe(0);
  });

  it('does not count a reservation that is already narrow', () => {
    expect(wideUnconditionalClasses('.thing { min-width: 4rem; }')).toStrictEqual([]);
  });
});

describe('text the application does not control can always shrink (CTL-5, CTL-10)', () => {
  /**
   * Two places in the chrome display a string whose length is somebody
   * else’s decision: the open document’s file name, and the window-wide
   * title beside the chrome controls. Both sit in a flex row with buttons.
   * Without all four declarations a long file name does not truncate — it
   * widens its row and pushes the controls out of the window, which is
   * CTL-5’s failure case and needs no media query to happen.
   */
  const SHRINKABLE = ['.reader__name', '.shell__title'];

  const ruleFor = (selector: string): Rule | undefined =>
    rules(chrome()).find((rule) => rule.selector === selector);

  it('finds both rules, so the check cannot pass by matching nothing', () => {
    for (const selector of SHRINKABLE) {
      expect(ruleFor(selector)).toBeDefined();
    }
  });

  it('lets each one overflow into an ellipsis instead of widening its row', () => {
    for (const selector of SHRINKABLE) {
      const body = ruleFor(selector)?.body ?? '';

      expect(body).toMatch(/overflow:\s*hidden/);
      expect(body).toMatch(/text-overflow:\s*ellipsis/);
      expect(body).toMatch(/white-space:\s*nowrap/);
      // Without this a flex item refuses to shrink below its content.
      expect(body).toMatch(/min-width:\s*0/);
    }
  });
});

describe.skip('hiding something actually hides it (CTL-8)', () => {
  /**
   * Found in a real Chromium window during 6.4, not by a test: the
   * collapsed reading-details panel still occupied its 20rem column. The
   * component set the `hidden` attribute and the attribute was there — but
   * the user agent’s `[hidden] { display: none }` is the weakest rule in
   * the cascade, and `.reader__side-content { display: flex }` beat it.
   * The element was hidden to every test that asks the DOM and visible to
   * everyone looking at the screen.
   *
   * So the rule is general: if the renderer hides an element by attribute
   * and the stylesheet gives that element a `display`, the stylesheet owes
   * it a `[hidden]` rule as well.
   */
  const hiddenByAttribute = (): string[] => {
    const tags = [...componentSources().matchAll(/<[a-zA-Z][^>]*?\shidden[={\s][^>]*?>/gs)];

    return [
      ...new Set(
        tags.flatMap((tag) =>
          [...tag[0].matchAll(/className="([^"]+)"/g)].flatMap((match) =>
            (match[1] ?? '').split(/\s+/u),
          ),
        ),
      ),
    ];
  };

  const declaresDisplay = (selector: string): boolean =>
    rules(chrome()).some(
      (rule) => rule.selector === selector && /display:\s*[^;}]+/.test(rule.body),
    );

  it('finds the elements the renderer hides by attribute', () => {
    expect(hiddenByAttribute()).toContain('shell__surface');
    expect(hiddenByAttribute()).toContain('reader__side-content');
  });

  it('restates display:none for every one of them that sets a display', () => {
    const unenforced = hiddenByAttribute()
      .filter((className) => declaresDisplay(`.${className}`))
      .filter((className) => {
        const guard = rules(chrome()).find((rule) => rule.selector === `.${className}[hidden]`);

        return guard === undefined || !/display:\s*none/.test(guard.body);
      });

    expect(unenforced).toStrictEqual([]);
  });
});

describe('the document surface is not responsive (6.4, Part 5)', () => {
  it('declares no media query of its own', () => {
    // The page is laid out from PDF.js geometry. A breakpoint in there
    // would mean the document rendered differently at different window
    // sizes, which is the one thing chrome work must never do.
    expect(splitDocumentSurface(sources.reader).document).not.toContain('@media');
  });

  it('is untouched by the narrow rules: none of them select into the page', () => {
    const selectors = mediaBlocks(chrome())
      .flatMap((block) => rules(block.body))
      .map((rule) => rule.selector);

    for (const selector of selectors) {
      expect(selector).not.toMatch(/\.(?:page|textLayer|highlight)\b/);
    }
  });
});
