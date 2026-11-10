import { describe, expect, it } from 'vitest';

import { extractContext, MAX_CONTEXT_CHARACTERS } from './context';

/** The excerpt is capped, whole-worded, one line, and optional. */

const prose =
  'The lighthouse keeper watched the harbour through a salt-stained window while the ' +
  'storm gathered strength over the headland and the gulls wheeled above the breakwater, ' +
  'calling to one another in the failing light of a long autumn afternoon that smelled of ' +
  'rain and rope and the cold iron of the lamp room above him.';

const rangeOf = (text: string, word: string): { start: number; end: number } => {
  const start = text.indexOf(word);

  return { start, end: start + word.length };
};

describe('extracting the context of a saved word', () => {
  it('centres the excerpt on the word and reports where the word is', () => {
    const { start, end } = rangeOf(prose, 'breakwater');
    const extracted = extractContext(prose, start, end);

    expect(extracted).not.toBeNull();
    expect(extracted?.context.slice(extracted.contextWordStart).startsWith('breakwater')).toBe(
      true,
    );
  });

  it('never exceeds the hard cap', () => {
    for (const word of ['lighthouse', 'harbour', 'storm', 'rain', 'lamp']) {
      const { start, end } = rangeOf(prose, word);

      expect(extractContext(prose, start, end)?.context.length).toBeLessThanOrEqual(
        MAX_CONTEXT_CHARACTERS,
      );
    }
  });

  it('fills the budget rather than returning a token', () => {
    const { start, end } = rangeOf(prose, 'breakwater');

    expect(extractContext(prose, start, end)?.context.length).toBeGreaterThan(200);
  });

  it('starts and ends on word boundaries', () => {
    const { start, end } = rangeOf(prose, 'breakwater');
    const context = extractContext(prose, start, end)?.context ?? '';

    expect(prose.includes(context.slice(0, 20))).toBe(true);
    expect(/^\S/u.test(context)).toBe(true);
    expect(/\S$/u.test(context)).toBe(true);

    const firstWord = context.split(' ')[0] ?? '';
    const lastWord = context.split(' ').at(-1) ?? '';

    expect(prose).toContain(` ${firstWord} `);
    expect(prose).toContain(lastWord);
  });

  it('collapses newlines and runs of spaces into single spaces', () => {
    const text = 'the   keeper\nwatched\n\n  the    harbour';
    const { start, end } = rangeOf(text, 'watched');
    const extracted = extractContext(text, start, end);

    expect(extracted?.context).toBe('the keeper watched the harbour');
    expect(extracted?.contextWordStart).toBe('the keeper '.length);
  });

  it('gives the whole budget to one side when the word is at the start of a page', () => {
    const { start, end } = rangeOf(prose, 'The');
    const extracted = extractContext(prose, start, end);

    expect(extracted?.contextWordStart).toBe(0);
    expect(extracted?.context.length).toBeGreaterThan(200);
  });

  it('gives the whole budget to one side when the word is at the end of a page', () => {
    const start = prose.lastIndexOf('him');
    const extracted = extractContext(prose, start, start + 'him'.length);

    expect(extracted).not.toBeNull();
    expect(extracted?.context.endsWith('him.')).toBe(true);
    expect(extracted?.context.length).toBeGreaterThan(200);
  });

  it('keeps a short page whole without inventing text', () => {
    const text = 'a short page about mice';
    const { start, end } = rangeOf(text, 'mice');

    expect(extractContext(text, start, end)).toEqual({
      context: 'a short page about mice',
      contextWordStart: 'a short page about '.length,
    });
  });

  it('returns null when the range does not describe the text', () => {
    expect(extractContext(prose, -1, 5)).toBeNull();
    expect(extractContext(prose, 5, 5)).toBeNull();
    expect(extractContext(prose, 9, 4)).toBeNull();
    expect(extractContext(prose, 0, prose.length + 1)).toBeNull();
    expect(extractContext(prose, 1.5, 4)).toBeNull();
  });

  it('returns null when there is no text layer at all', () => {
    expect(extractContext('', 0, 1)).toBeNull();
  });

  it('returns null when the range is only whitespace', () => {
    expect(extractContext('a   b', 1, 4)).toBeNull();
  });

  it('returns null rather than storing a word longer than the cap', () => {
    const giant = 'x'.repeat(MAX_CONTEXT_CHARACTERS + 1);

    expect(extractContext(giant, 0, giant.length)).toBeNull();
  });

  it('never returns more of the page than the window it was given', () => {
    const page = `${'filler '.repeat(400)}needle${' filler'.repeat(400)}`;
    const start = page.indexOf('needle');
    const extracted = extractContext(page, start, start + 'needle'.length);

    expect(extracted?.context.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARACTERS);
    expect(page.length).toBeGreaterThan(5_000);
  });
});
