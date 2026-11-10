/**
 * Test support for the design-token layer (ADR-029).
 *
 * The stylesheets are examined as text rather than through a CSS engine: the
 * rules being enforced are about the source — which names it may contain, and
 * where — and reading the text states them without adding a dependency.
 *
 * These tests live outside `src/renderer` on purpose. They read files, and the
 * renderer is forbidden to reach the file system (docs/ARCHITECTURE.md,
 * enforced by eslint); Vitest also stubs CSS imports to an empty string, so
 * the sources have to be read rather than imported.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RENDERER = join(REPOSITORY_ROOT, 'src', 'renderer', 'src');
const STYLES = join(RENDERER, 'styles');

const read = (path: string): string => readFileSync(path, 'utf8');

export const sources = {
  tokens: read(join(STYLES, 'tokens.css')),
  global: read(join(STYLES, 'global.css')),
  reader: read(join(STYLES, 'reader.css')),
  main: read(join(RENDERER, 'main.tsx')),
  /** The renderer document, which carries the theme attribute (ADR-030). */
  html: read(join(REPOSITORY_ROOT, 'src', 'renderer', 'index.html')),
  /** The main process's half of ADR-030, read as text, never imported. */
  windowTheme: read(join(REPOSITORY_ROOT, 'src', 'main', 'theme', 'windowTheme.ts')),
} as const;

/**
 * Every component source in the renderer, excluding the tests themselves.
 *
 * Components only, deliberately: the callers of this are about markup —
 * which element carries a `data-testid`, which tag renders a `<Message>`,
 * which attribute is `hidden`. An invariant about renderer *JavaScript* as a
 * whole must not use this, because half the renderer is `.ts`; use
 * `rendererModules` instead.
 */
export const componentSources = (): string => {
  const collect = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        return collect(path);
      }

      return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [read(path)] : [];
    });

  return collect(RENDERER).join('\n');
};

/**
 * Removes comments from TypeScript source, leaving the code that runs.
 *
 * A prohibition on a name — `matchMedia`, `nativeTheme` — is a prohibition
 * on calling it, not on explaining why it is not called. The module that
 * documents its own refusal to call `window.matchMedia` would otherwise be
 * the first thing such a rule reports, which teaches the next reader to
 * delete the explanation rather than keep the rule.
 *
 * String and template literals are stepped over rather than scanned, so a
 * comment marker inside a string is not mistaken for a comment; whitespace
 * replaces what is removed, so line and column numbers still line up.
 */
export const stripComments = (code: string): string => {
  let result = '';
  let index = 0;

  const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

  while (index < code.length) {
    const character = code[index] ?? '';
    const next = code[index + 1] ?? '';

    if (character === '/' && next === '/') {
      const end = code.indexOf('\n', index);
      const stop = end === -1 ? code.length : end;

      result += blank(code.slice(index, stop));
      index = stop;
      continue;
    }

    if (character === '/' && next === '*') {
      const end = code.indexOf('*/', index + 2);
      const stop = end === -1 ? code.length : end + 2;

      result += blank(code.slice(index, stop));
      index = stop;
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      let cursor = index + 1;

      while (cursor < code.length) {
        if (code[cursor] === '\\') {
          cursor += 2;
          continue;
        }

        if (code[cursor] === character) {
          cursor += 1;
          break;
        }

        cursor += 1;
      }

      result += code.slice(index, cursor);
      index = cursor;
      continue;
    }

    result += character;
    index += 1;
  }

  return result;
};

/** One renderer module: where it is, and what it does once comments are gone. */
export interface RendererModule {
  /** Repository-relative, so a failure names the file to open. */
  readonly path: string;
  /** The source with comments removed. */
  readonly code: string;
}

/**
 * Every module the renderer ships, `.ts` and `.tsx` alike, tests excluded.
 *
 * `componentSources` sees only `.tsx`. That is right for a question about
 * markup and wrong for a question about the renderer's behaviour: the
 * renderer has more `.ts` modules than `.tsx` ones, and a rule that cannot
 * see them is a rule that reads as enforced and is not. ADR-030's two
 * mechanism invariants — no `matchMedia` in application JavaScript, one
 * writer of the theme attribute — are asked of this list.
 */
export const rendererModules = (): readonly RendererModule[] => {
  const collect = (directory: string): RendererModule[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        return collect(path);
      }

      const isModule = entry.name.endsWith('.ts') || entry.name.endsWith('.tsx');
      const isTest = /\.test\.tsx?$/.test(entry.name);

      return isModule && !isTest
        ? [
            {
              path: path.slice(REPOSITORY_ROOT.length + 1).replaceAll('\\', '/'),
              code: stripComments(read(path)),
            },
          ]
        : [];
    });

  return collect(RENDERER);
};

/**
 * Writes of the theme attribute, however they are spelled.
 *
 * `setAttribute` with the literal or with the exported constant, and the
 * `dataset` form, which is the same write in different clothing.
 */
export const THEME_ATTRIBUTE_WRITE =
  /setAttribute\(\s*(?:['"`]data-theme['"`]|THEME_ATTRIBUTE)|\.dataset\.theme\s*=[^=]/g;

/** Marks the start of the region that renders the document, not the chrome. */
export const DOCUMENT_SURFACE_START = '/* === DOCUMENT SURFACE — begin';

/** Marks the end of that region. */
export const DOCUMENT_SURFACE_END = '/* === DOCUMENT SURFACE — end';

/** Marks the start of the one region that is allowed to move (ADR-032). */
export const MOTION_START = '/* === MOTION — begin';

/** Marks the end of that region. */
export const MOTION_END = '/* === MOTION — end';

/** Removes CSS comments, so that prose is never mistaken for a rule. */
export const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Splits a stylesheet into the application chrome, which the token rules
 * govern, and the document surface, which is an architectural boundary.
 */
export const splitDocumentSurface = (css: string): { chrome: string; document: string } => {
  const start = css.indexOf(DOCUMENT_SURFACE_START);

  if (start === -1) {
    return { chrome: css, document: '' };
  }

  const end = css.indexOf(DOCUMENT_SURFACE_END);

  if (end === -1) {
    throw new Error('The document surface region is opened but never closed.');
  }

  const newline = css.indexOf('\n', end);
  const endOfRegion = newline === -1 ? css.length : newline;

  return {
    chrome: css.slice(0, start) + css.slice(endOfRegion),
    document: css.slice(start, endOfRegion),
  };
};

/**
 * Splits a stylesheet into the part that is allowed to move and the part
 * that is not (ADR-032, Milestone 6.7).
 *
 * The motion region is a fence in the same sense as the document surface:
 * the rule being enforced is not "these animations are correct" but
 * "there are no others anywhere", which is only checkable if the region
 * has an edge. A stylesheet without the markers is entirely `still`.
 */
export const splitMotion = (css: string): { still: string; motion: string } => {
  const start = css.indexOf(MOTION_START);

  if (start === -1) {
    return { still: css, motion: '' };
  }

  const end = css.indexOf(MOTION_END);

  if (end === -1) {
    throw new Error('The motion region is opened but never closed.');
  }

  const newline = css.indexOf('\n', end);
  const endOfRegion = newline === -1 ? css.length : newline;

  return {
    still: css.slice(0, start) + css.slice(endOfRegion),
    motion: css.slice(start, endOfRegion),
  };
};

/**
 * The conditional group at-rules: the ones that wrap whole rules rather
 * than declarations. 6.4 introduced the first of them (`@media`, W6).
 */
const GROUP_AT_RULES = /@(?:media|supports|container|layer|scope)\b/;

/** One `@keyframes` block: its name and the steps it is made of. */
export interface KeyframesBlock {
  /** The animation name, as `animation` refers to it. */
  readonly name: string;
  /** The whole block body, braces excluded: the steps and their text. */
  readonly body: string;
  /** Every property one of its steps declares, in source order. */
  readonly properties: readonly string[];
}

/**
 * Walks a stylesheet, handing each `@keyframes` block to a visitor and
 * returning the text with those blocks removed.
 *
 * Comments are stepped over rather than scanned, so prose that mentions a
 * keyframe is not mistaken for one.
 */
const partitionKeyframes = (css: string, visit: (block: KeyframesBlock) => void): string => {
  let result = '';
  let index = 0;

  while (index < css.length) {
    const comment = css.indexOf('/*', index);
    const at = css.toLowerCase().indexOf('@keyframes', index);

    if (at === -1) {
      result += css.slice(index);
      break;
    }

    if (comment !== -1 && comment < at) {
      const close = css.indexOf('*/', comment + 2);
      const stop = close === -1 ? css.length : close + 2;

      result += css.slice(index, stop);
      index = stop;
      continue;
    }

    const open = css.indexOf('{', at);

    if (open === -1) {
      throw new Error('A @keyframes block is opened but never closed.');
    }

    let depth = 1;
    let cursor = open + 1;

    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') {
        depth += 1;
      } else if (css[cursor] === '}') {
        depth -= 1;
      }

      cursor += 1;
    }

    if (depth !== 0) {
      throw new Error('A @keyframes block is opened but never closed.');
    }

    const body = css.slice(open + 1, cursor - 1);

    visit({
      name: css.slice(at + '@keyframes'.length, open).trim(),
      body,
      properties: [...body.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:/g)].map((match) => match[1] ?? ''),
    });

    result += css.slice(index, at);
    index = cursor;
  }

  return result;
};

/**
 * Every `@keyframes` block a stylesheet defines (ADR-032, Milestone 6.7).
 *
 * The analysers below read flat `selector { declarations }` text, and a
 * keyframes block is neither: its "selectors" are `from`, `to` and
 * percentages, and its declarations belong to no element. Rather than let
 * them be flattened into rules that do not exist, they are lifted out
 * here, so the motion tests can state what a keyframe may contain — and so
 * every other analyser goes on seeing only real rules.
 */
export const keyframeBlocks = (css: string): readonly KeyframesBlock[] => {
  const blocks: KeyframesBlock[] = [];

  partitionKeyframes(css, (block) => blocks.push(block));

  return blocks;
};

/** The stylesheet with its `@keyframes` blocks removed. */
export const withoutKeyframes = (css: string): string => partitionKeyframes(css, () => undefined);

/**
 * Lifts the rules inside conditional group at-rules up to the top level.
 *
 * Every analyser here reads flat `selector { declarations }` text. A media
 * query nests a second level of braces inside the first, which would make
 * a rule invisible to a text analyser that was not expecting it — and an
 * invisible rule is one the token, contrast and typography floors stop
 * policing. Rather than forbidding media queries, the wrapper is removed
 * and its contents are examined exactly like any other rule.
 *
 * At-rules that contain declarations rather than rules are never
 * flattened: hoisting their declarations would invent rules that do not
 * exist. `@keyframes`, which 6.7 introduced, is removed first and read
 * separately by `keyframeBlocks`; `@font-face`, `@page` and `@property`
 * are unused, and this throws if one appears, so the analysers cannot
 * silently start reading something they were not written for.
 */
export const flattenAtRules = (source: string): string => {
  const css = withoutKeyframes(source);
  const unsupported = /@(?:font-face|page|property)\b/.exec(withoutComments(css));

  if (unsupported !== null) {
    throw new Error(
      `${unsupported[0]} nests declarations, not rules; the style analysers cannot read it.`,
    );
  }

  let result = '';
  let index = 0;

  while (index < css.length) {
    const at = css.indexOf('@', index);

    if (at === -1) {
      result += css.slice(index);
      break;
    }

    const open = css.indexOf('{', at);

    if (open === -1 || !GROUP_AT_RULES.test(css.slice(at, open))) {
      result += css.slice(index, at + 1);
      index = at + 1;
      continue;
    }

    let depth = 1;
    let cursor = open + 1;

    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') {
        depth += 1;
      } else if (css[cursor] === '}') {
        depth -= 1;
      }

      cursor += 1;
    }

    if (depth !== 0) {
      throw new Error('An at-rule block is opened but never closed.');
    }

    result += css.slice(index, at);
    // The prelude and the two braces go; everything they wrapped stays.
    result += flattenAtRules(css.slice(open + 1, cursor - 1));
    index = cursor;
  }

  return result;
};

/** The custom properties a stylesheet defines, in source order. */
export const definedTokens = (css: string): string[] =>
  [...withoutComments(css).matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((match) => match[1] ?? '');

/** The custom properties a stylesheet reads through `var()`. */
export const referencedTokens = (css: string): string[] =>
  [...withoutComments(css).matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1] ?? '');

/** Every declaration of one property, as trimmed value strings. */
export const declarationsOf = (css: string, property: string): string[] =>
  [...withoutComments(css).matchAll(new RegExp(`(?:^|[;{])\\s*${property}\\s*:([^;}]+)`, 'g'))].map(
    (match) => (match[1] ?? '').trim(),
  );

/** Every class name a stylesheet selects on, at-rules included. */
export const selectedClasses = (css: string): string[] => {
  const selectorsOnly = flattenAtRules(withoutComments(css)).replace(/\{[^}]*\}/g, ' ');

  return [
    ...new Set([...selectorsOnly.matchAll(/\.([A-Za-z][\w-]*)/g)].map((match) => match[1] ?? '')),
  ];
};

/** The relative luminance of an `#rrggbb` colour (WCAG 2.2 definition). */
export const relativeLuminance = (hex: string): number => {
  const value = hex.replace('#', '');

  if (!/^[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`Not a six-digit hex colour: ${hex}`);
  }

  const channel = (pair: string): number => {
    const srgb = Number.parseInt(pair, 16) / 255;

    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };

  return (
    0.2126 * channel(value.slice(0, 2)) +
    0.7152 * channel(value.slice(2, 4)) +
    0.0722 * channel(value.slice(4, 6))
  );
};

/** The WCAG 2.2 contrast ratio between two opaque colours, to two decimals. */
export const contrastRatio = (foreground: string, background: string): number => {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const ratio = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);

  return Math.round(ratio * 100) / 100;
};

/**
 * An `#rrggbb` or `rgb(r g b / a%)` colour, as channels and an alpha.
 *
 * Only the two notations the stylesheets actually use are accepted, and
 * anything else throws: a colour this cannot read is a colour the floors
 * below would otherwise skip silently.
 */
export const parseColour = (
  value: string,
): { red: number; green: number; blue: number; alpha: number } => {
  const text = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(text);

  if (hex?.[1] !== undefined) {
    return {
      red: Number.parseInt(hex[1].slice(0, 2), 16),
      green: Number.parseInt(hex[1].slice(2, 4), 16),
      blue: Number.parseInt(hex[1].slice(4, 6), 16),
      alpha: 1,
    };
  }

  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*(\d+(?:\.\d+)?)%)?\s*\)$/.exec(text);

  if (rgb === null) {
    throw new Error(`Not a colour this helper can read: ${value}`);
  }

  return {
    red: Number(rgb[1]),
    green: Number(rgb[2]),
    blue: Number(rgb[3]),
    alpha: rgb[4] === undefined ? 1 : Number(rgb[4]) / 100,
  };
};

/**
 * What a translucent colour actually looks like over an opaque one.
 *
 * Contrast is a property of pixels, not of declarations. The page-failure
 * overlay is a translucent panel over the white page, so the colour its
 * text has to be legible against is the composite, which is lighter —
 * and therefore a stricter floor — than the panel colour as written.
 */
export const composite = (over: string, under: string): string => {
  const top = parseColour(over);
  const bottom = parseColour(under);

  if (bottom.alpha !== 1) {
    throw new Error(`The lower colour must be opaque: ${under}`);
  }

  const mix = (first: number, second: number): string =>
    Math.round(top.alpha * first + (1 - top.alpha) * second)
      .toString(16)
      .padStart(2, '0');

  return `#${mix(top.red, bottom.red)}${mix(top.green, bottom.green)}${mix(top.blue, bottom.blue)}`;
};

/** One declared value out of one rule, by selector and property. */
export const declaredValue = (css: string, selector: string, property: string): string => {
  const rule = new RegExp(
    `(?:^|\\})\\s*${selector.replace(/[.\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(withoutComments(css));

  if (rule?.[1] === undefined) {
    throw new Error(`No rule for ${selector}.`);
  }

  const declaration = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(rule[1]);

  if (declaration?.[1] === undefined) {
    throw new Error(`${selector} declares no ${property}.`);
  }

  return declaration[1].trim();
};

/**
 * The appearances `tokens.css` defines a palette for (ADR-030).
 *
 * `dark` is `:root` itself: it is the base palette, the one an explicit dark
 * root and a dark system both land on.
 */
export type Palette = 'dark' | 'light' | 'light-system';

/** Where each palette is written down, as a selector to search for. */
const PALETTE_BLOCKS: Readonly<Record<Palette, RegExp>> = {
  dark: /(^|\n):root\s*\{/,
  light: /:root\[data-theme='light'\]\s*\{/,
  'light-system': /:root\[data-theme='system'\]\s*\{/,
};

/** The text of one palette's block, braces excluded. */
export const paletteBlock = (palette: Palette): string => {
  const css = withoutComments(sources.tokens);
  const match = PALETTE_BLOCKS[palette].exec(css);

  if (match === null) {
    throw new Error(`tokens.css has no ${palette} palette.`);
  }

  const open = css.indexOf('{', match.index);
  let depth = 1;
  let cursor = open + 1;

  while (cursor < css.length && depth > 0) {
    if (css[cursor] === '{') {
      depth += 1;
    } else if (css[cursor] === '}') {
      depth -= 1;
    }

    cursor += 1;
  }

  if (depth !== 0) {
    throw new Error(`The ${palette} palette block is opened but never closed.`);
  }

  return css.slice(open + 1, cursor - 1);
};

/**
 * One token's value in one appearance.
 *
 * A palette only restates the tokens it changes, so a name the light block
 * does not mention keeps its `:root` value — which is exactly how the
 * cascade resolves it, and why the document-surface colours are the same in
 * both appearances. A token defined as another token is followed within the
 * same palette.
 */
export const paletteValue = (
  name: string,
  palette: Palette,
  seen: readonly string[] = [],
): string => {
  if (seen.includes(name)) {
    throw new Error(`tokens.css defines ${name} in terms of itself.`);
  }

  const find = (block: string): string | null =>
    new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+);`, 'm').exec(block)?.[1]?.trim() ?? null;

  const value =
    (palette === 'dark' ? null : find(paletteBlock(palette))) ?? find(paletteBlock('dark'));

  if (value === null) {
    throw new Error(`tokens.css does not define ${name}.`);
  }

  const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);

  return reference?.[1] === undefined
    ? value
    : paletteValue(reference[1], palette, [...seen, name]);
};

/**
 * Reads one token's declared value out of `tokens.css`, following a token
 * that is defined as another token (`--colour-control: var(--colour-…)`).
 */
export const tokenValue = (name: string, seen: readonly string[] = []): string => {
  if (seen.includes(name)) {
    throw new Error(`tokens.css defines ${name} in terms of itself.`);
  }

  const match = new RegExp(`^\\s*${name}\\s*:\\s*([^;]+);`, 'm').exec(
    withoutComments(sources.tokens),
  );

  if (match === null || match[1] === undefined) {
    throw new Error(`tokens.css does not define ${name}.`);
  }

  const value = match[1].trim();
  const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);

  return reference?.[1] === undefined ? value : tokenValue(reference[1], [...seen, name]);
};
