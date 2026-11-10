/**
 * Motion, as a property of the source (ADR-032, Milestone 6.7).
 *
 * ADR-032 permits four animations and forbids everything else, which makes
 * the interesting assertions negative ones: what is *not* in the source.
 * A test that reads the four rules and agrees with them would pass just as
 * happily beside a fifth animation nobody reviewed, a dismissal that fades
 * out, a keyframe that moves a layout property, a reduced-motion override
 * that something outranks, or a smooth scroll in JavaScript — and those are
 * the failures that actually happen.
 *
 * So the shape of this file is: everything that moves is inside one fenced
 * region; the region contains exactly these four behaviours with exactly
 * these durations; each entry can only fade and slide; nothing moves on the
 * way out; and the reduced-motion switch reaches all of it without
 * `!important` and without depending on source order.
 *
 * What a text analyser cannot prove — that the engine really plays the
 * animation, that it really stops when the setting is on — is verified in a
 * real Electron renderer and recorded in the completion report.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MOTION_END,
  MOTION_START,
  flattenAtRules,
  keyframeBlocks,
  rendererModules,
  sources,
  splitDocumentSurface,
  splitMotion,
  tokenValue,
  withoutComments,
  type KeyframesBlock,
} from './stylesheetSource';

const PACKAGE_JSON = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
  'package.json',
);

/** The one region that is allowed to move. */
const motion = withoutComments(splitMotion(sources.global).motion);

/** Everything else: the two other stylesheets, and the rest of global.css. */
const still = [sources.tokens, splitMotion(sources.global).still, sources.reader].map((css) =>
  withoutComments(css),
);

/** Anything that makes a thing move, however it is spelled. */
const MOVING = /(?:^|[;{\s])(?:transition|animation|scroll-behavior|offset-path|will-change)\b/;

/** What the reduced-motion override declares, and all it may declare. */
const DISABLED = 'animation: none; transition: none;';

/** One `selector { body }` rule out of the motion region, at-rules lifted. */
interface MotionRule {
  readonly selector: string;
  readonly body: string;
}

const motionRules = (css: string): MotionRule[] =>
  [...flattenAtRules(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? '').trim().replace(/\s+/g, ' '),
    body: (match[2] ?? '').trim().replace(/\s+/g, ' '),
  }));

/** The rules that actually move something: the override is not one. */
const animatingRules = (): MotionRule[] =>
  motionRules(motion).filter((rule) => rule.body !== DISABLED);

/** The rules that declare one property, by the selector that declares it. */
const declaring = (property: string): Map<string, string> =>
  new Map(
    animatingRules()
      .map((rule): [string, string] => [
        rule.selector,
        new RegExp(`(?:^|[;{])\\s*${property}\\s*:([^;}]+)`).exec(rule.body)?.[1]?.trim() ?? '',
      ])
      .filter(([, value]) => value !== ''),
  );

const keyframe = (name: string): KeyframesBlock => {
  const block = keyframeBlocks(motion).find((candidate) => candidate.name === name);

  if (block === undefined) {
    throw new Error(`The motion region defines no @keyframes ${name}.`);
  }

  return block;
};

/** The `translateY` a keyframe starts from, in pixels. */
const startOffset = (name: string): number => {
  const match = /translateY\((-?[\d.]+)px\)/.exec(keyframe(name).body);

  if (match?.[1] === undefined) {
    throw new Error(`@keyframes ${name} does not start from a vertical offset.`);
  }

  return Number(match[1]);
};

describe('all motion is in one place', () => {
  it('fences the region off in global.css', () => {
    expect(sources.global).toContain(MOTION_START);
    expect(sources.global).toContain(MOTION_END);
    expect(motion).not.toBe('');
  });

  it('leaves nothing that moves outside the fence', () => {
    // The assertion that makes the rest of this file worth having: a fifth
    // animation added next to the component it belongs to fails here, not
    // in review.
    for (const css of still) {
      expect(css).not.toMatch(MOVING);
      expect(css).not.toMatch(/@keyframes/);
    }
  });

  it('finds the fence would catch a stray animation', () => {
    // Without this the test above could pass because the pattern never
    // matches anything.
    expect('.toolbar {\n  transition: background-color 80ms;\n}').toMatch(MOVING);
    expect('.popup {\n  animation: enter 120ms;\n}').toMatch(MOVING);
    expect('.reader__scroller {\n  scroll-behavior: smooth;\n}').toMatch(MOVING);
  });

  it('has no fourth stylesheet to hide motion in', () => {
    const imported = [...sources.main.matchAll(/import '\.\/([\w/.]+\.css)'/g)].map(
      (match) => match[1] ?? '',
    );

    expect(imported).toStrictEqual(['styles/tokens.css', 'styles/global.css', 'styles/reader.css']);
  });

  it('stays small enough to read in one sitting', () => {
    /*
     * ADR-032 budgeted "under ~40 lines" of motion CSS. The measured
     * figure is 57 lines once comments and blank lines are removed: the
     * estimate did not itemise four separate keyframe blocks or an
     * override with four selectors on each of its two triggers. The
     * budget is therefore recorded at what it actually costs, which is
     * still one screen, rather than quietly redefined as something
     * smaller — and it cannot grow past 60 without this failing.
     */
    const lines = motion.split('\n').filter((line) => line.trim().length > 0);

    expect(lines.length).toBeLessThanOrEqual(60);
  });
});

describe('the four animations ADR-032 permits', () => {
  it('are exactly four, on exactly these surfaces', () => {
    expect([...declaring('animation').keys()]).toStrictEqual([
      ':where(.dictionary-popup--below)',
      ':where(.dictionary-popup--above)',
      ':where(.library__undo)',
      ':where(.search)',
    ]);

    expect([...declaring('transition').keys()]).toStrictEqual([
      ':where(.control:is(:hover, :focus-visible):enabled)',
    ]);
  });

  it('spends the duration ADR-032 chose for each', () => {
    const durations = new Map(
      [...declaring('animation'), ...declaring('transition')].map(([selector, value]) => [
        selector,
        [...value.matchAll(/var\((--motion-[\w-]+)\)/g)].map((match) => match[1] ?? ''),
      ]),
    );

    expect(durations.get(':where(.dictionary-popup--below)')).toStrictEqual(['--motion-popup']);
    expect(durations.get(':where(.dictionary-popup--above)')).toStrictEqual(['--motion-popup']);
    expect(durations.get(':where(.library__undo)')).toStrictEqual(['--motion-slow']);
    expect(durations.get(':where(.search)')).toStrictEqual(['--motion-base']);
    expect(durations.get(':where(.control:is(:hover, :focus-visible):enabled)')).toStrictEqual([
      '--motion-fast',
      '--motion-fast',
      '--motion-fast',
    ]);
  });

  it('resolves those tokens to the reviewed milliseconds', () => {
    expect(tokenValue('--motion-popup')).toBe('120ms');
    expect(tokenValue('--motion-slow')).toBe('140ms');
    expect(tokenValue('--motion-base')).toBe('100ms');
    expect(tokenValue('--motion-fast')).toBe('80ms');
  });

  it('eases each one the way the decision records', () => {
    const animation = declaring('animation');

    expect(animation.get(':where(.dictionary-popup--below)')).toContain('var(--ease-out)');
    expect(animation.get(':where(.dictionary-popup--above)')).toContain('var(--ease-out)');
    expect(animation.get(':where(.library__undo)')).toContain('var(--ease-out)');
    // The search panel fades on a straight line: a curve on an opacity
    // this short reads as a stutter, not as a decision.
    expect(animation.get(':where(.search)')).toContain('linear');
    expect(animation.get(':where(.search)')).not.toContain('ease');

    for (const value of declaring('transition').values()) {
      expect(value).toContain('var(--ease-standard)');
    }
  });

  it('is nowhere near long enough to be waited for', () => {
    for (const name of ['--motion-fast', '--motion-base', '--motion-popup', '--motion-slow']) {
      expect(Number.parseFloat(tokenValue(name))).toBeLessThanOrEqual(150);
    }
  });
});

describe('an entry animation can only fade and slide', () => {
  const blocks = (): readonly KeyframesBlock[] => keyframeBlocks(motion);

  it('defines one keyframe set per animation and no spare ones', () => {
    expect(blocks().map((block) => block.name)).toStrictEqual([
      'popup-enter-below',
      'popup-enter-above',
      'undo-enter',
      'search-enter',
    ]);
  });

  it('touches no property that costs a layout', () => {
    for (const block of blocks()) {
      expect(new Set(block.properties)).toStrictEqual(
        new Set(block.properties.filter((name) => name === 'opacity' || name === 'transform')),
      );
      expect(block.properties).toContain('opacity');
    }
  });

  it('transforms by translation only, never by scaling or rotating', () => {
    for (const block of blocks()) {
      const transforms = [...block.body.matchAll(/transform:\s*([^;]+)/g)].map(
        (match) => match[1] ?? '',
      );

      for (const value of transforms) {
        expect(value).toMatch(/^translateY\(-?[\d.]+px\)$/);
      }
    }
  });

  it('says only where it starts, so the resting state is the element itself', () => {
    /*
     * A `from`-only keyframe cannot strand anything: whatever the engine
     * does — plays it, interrupts it, never runs it because motion is
     * reduced — the element ends up at the style it was written with.
     * A `to { opacity: 1 }` would look identical today and would hide a
     * popup the day someone changed the popup's own opacity.
     */
    for (const block of blocks()) {
      expect(block.body).toMatch(/(?:^|[}\s])from\s*\{/);
      expect(block.body).not.toMatch(/(?:^|[}\s])to\s*\{/);
      expect(block.body).not.toMatch(/\b100%/);
    }
  });

  it('moves the popup towards the word it defines, whichever side it is on', () => {
    // Below the word, the popup rises into place from underneath; flipped
    // above it, it settles downwards. Both end up moving towards the
    // anchor, which is what makes the movement read as "from the word".
    expect(startOffset('popup-enter-below')).toBeGreaterThan(0);
    expect(startOffset('popup-enter-above')).toBeLessThan(0);
    expect(startOffset('popup-enter-below')).toBe(-startOffset('popup-enter-above'));
    expect(Math.abs(startOffset('popup-enter-below'))).toBe(3);
  });

  it('raises the undo bar by the four pixels the decision names', () => {
    expect(startOffset('undo-enter')).toBe(4);
  });

  it('only fades the search panel, which lives inside the toolbar', () => {
    expect(keyframe('search-enter').properties).toStrictEqual(['opacity']);
  });
});

describe('nothing animates on the way out', () => {
  it('declares no animation that ends invisible', () => {
    for (const block of keyframeBlocks(motion)) {
      expect(block.body).not.toMatch(/to\s*\{[^}]*opacity:\s*0/);
    }
  });

  it('has no exit, closing or leaving state to animate', () => {
    expect(motion).not.toMatch(/--(?:exit|closing|leaving|hidden|out)\b/);
    expect(motion).not.toMatch(/\b(?:exit|leave|out)-/);
  });

  it('leaves the dismissed surfaces unmounted rather than faded', () => {
    // The three animated surfaces are rendered conditionally, so there is
    // no element left to animate out. An `animation` on a component that
    // React keeps mounted would be the first sign that changed.
    const components = rendererModules().filter((module) =>
      /WordDefinitionPopup|LibraryView|SearchPanel/.test(module.path),
    );

    expect(components).toHaveLength(3);
    for (const component of components) {
      expect(component.code).not.toMatch(/animation|transition|\.animate\(/);
    }
  });
});

describe('the reduced-motion switch', () => {
  const override = (): string => {
    const index = motion.indexOf('@media (prefers-reduced-motion: reduce)');

    if (index === -1) {
      throw new Error('The motion region has no reduced-motion override.');
    }

    return motion.slice(index);
  };

  it('answers the operating system', () => {
    expect(motion).toContain('@media (prefers-reduced-motion: reduce)');
    expect(motion).not.toMatch(/prefers-reduced-motion:\s*no-preference/);
  });

  it('answers an explicit preference through the document element', () => {
    expect(motion).toContain(":root[data-motion='reduced']");
    expect(sources.html).toMatch(/<html[^>]*\bdata-motion="system"/);
  });

  it('applies each trigger to every part of its own selector list', () => {
    // A partial rename — three of the four selectors still saying
    // `reduced` — would leave the override looking present and reaching
    // only some of the document.
    for (const rule of motionRules(override())) {
      const parts = rule.selector.split(',').map((part) => part.trim());
      const prefix = parts[0] ?? '';

      expect(prefix).toMatch(/^:root(?:\[data-motion='reduced'\])?$/);
      for (const part of parts) {
        expect(part.startsWith(prefix)).toBe(true);
      }
    }
  });

  it('reaches every element and both pseudo-elements, under both triggers', () => {
    for (const rule of motionRules(override())) {
      expect(rule.selector).toContain('*');
      expect(rule.selector).toContain('::before');
      expect(rule.selector).toContain('::after');
    }

    expect(motionRules(override())).toHaveLength(2);
  });

  it('disables motion rather than shortening it', () => {
    /*
     * The `0.01ms` idiom is the common one and it is wrong: the animation
     * still runs, `animationend` still fires, and a reader who asked for
     * no motion gets a one-frame flicker instead of a still interface.
     */
    for (const rule of motionRules(override())) {
      expect(rule.body).toBe(DISABLED);
    }
  });

  it('names no property, so it covers the animation nobody has written yet', () => {
    expect(override()).not.toMatch(/opacity|transform|background-color|colou?r/);
  });

  it('outranks every animation without `!important`', () => {
    /*
     * The override is a plain descendant selector; each thing it has to
     * beat is wrapped in `:where()`, whose specificity is zero. So the
     * cascade decides this on specificity, not on which rule happens to
     * be written last — and the stylesheet keeps its property of
     * containing no `!important` at all.
     */
    for (const selector of [...declaring('animation').keys(), ...declaring('transition').keys()]) {
      expect(selector.startsWith(':where(')).toBe(true);
      expect(selector.endsWith(')')).toBe(true);
    }

    expect(motion).not.toContain('!important');
    for (const rule of motionRules(override())) {
      expect(rule.selector).not.toContain(':where(');
    }
  });

  it('is asked for in CSS, never by JavaScript', () => {
    for (const module of rendererModules()) {
      expect(module.code).not.toContain('matchMedia');
      expect(module.code).not.toContain('prefers-reduced-motion');
    }
  });
});

describe('the document surface does not move', () => {
  const document_ = withoutComments(splitDocumentSurface(sources.reader).document);

  it('declares no motion of its own', () => {
    expect(document_).not.toMatch(MOVING);
  });

  it('is animated by no rule in the motion region', () => {
    // The one rule that does reach the document is the reduced-motion
    // override, which only ever takes motion away.
    for (const rule of animatingRules()) {
      expect(rule.selector).not.toMatch(/\.page|canvas|\.textLayer|\.highlight/);
    }
  });

  it('scrolls instantly, in the stylesheet and in the renderer alike', () => {
    // ADR-032 forbids `scroll-behavior: smooth` outright: the reader's
    // position is where it was put, not somewhere it is gliding towards.
    // Matched as a property, not as a substring: `overscroll-behavior`,
    // which the scroller does set, is a different property about a
    // different thing and contains this one's name.
    for (const css of [...still, motion]) {
      expect(css).not.toMatch(/(?:^|[;{\s])scroll-behavior\s*:/);
    }

    for (const module of rendererModules()) {
      expect(module.code).not.toMatch(/behavior:\s*['"]smooth['"]/);
    }
  });
});

describe('motion is CSS, not a script', () => {
  it('runs no animation from JavaScript', () => {
    for (const module of rendererModules()) {
      expect(module.code).not.toMatch(/\.animate\(|KeyframeEffect|new Animation\b/);
      expect(module.code).not.toMatch(/style\.(?:transition|animation)/);
      expect(module.code).not.toMatch(/animationend|transitionend/);
    }
  });

  it('keeps its one animation frame for reading, not for moving', () => {
    // `useScrollViewport` throttles scroll *sampling* to a frame. It is
    // the only `requestAnimationFrame` in the renderer and it writes no
    // style; a second one would be where a hand-rolled tween appeared.
    const users = rendererModules().filter((module) =>
      module.code.includes('requestAnimationFrame'),
    );

    expect(users.map((module) => module.path)).toStrictEqual([
      'src/renderer/src/reader/useScrollViewport.ts',
    ]);
    expect(users[0]?.code).not.toMatch(/\.style\b/);
  });

  it('added no animation dependency', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    for (const name of Object.keys(manifest.dependencies ?? {})) {
      expect(name).not.toMatch(/motion|spring|anime|gsap|tween|transition|lottie/i);
    }
  });
});
