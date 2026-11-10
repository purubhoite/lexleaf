import { describe, expect, it } from 'vitest';

import { firstWordOf, lastWordOf, nextWordFrom, previousWordFrom, wordOnEntry } from './wordCursor';

const text = 'The sailor\u2019s well-worn chart, folded twice.';

const at = (span: { start: number; end: number } | null): string | null =>
  span === null ? null : text.slice(span.start, span.end);

describe('keyboard word cursor', () => {
  it('finds the first and last word of a page', () => {
    expect(at(firstWordOf(text))).toBe('The');
    expect(at(lastWordOf(text))).toBe('twice');
  });

  it('enters a page from the correct end', () => {
    expect(at(wordOnEntry(text, 'forward'))).toBe('The');
    expect(at(wordOnEntry(text, 'backward'))).toBe('twice');
  });

  it('moves forward a word at a time, using the shared boundary rules', () => {
    const walked: (string | null)[] = [];
    let index = -1;

    for (let step = 0; step < 6; step += 1) {
      const span = nextWordFrom(text, index);

      if (span === null) {
        break;
      }

      walked.push(at(span));
      index = span.start;
    }

    expect(walked).toEqual(['The', 'sailor\u2019s', 'well-worn', 'chart', 'folded', 'twice']);
  });

  it('moves backward a word at a time', () => {
    const walked: (string | null)[] = [];
    let index = text.length;

    for (let step = 0; step < 6; step += 1) {
      const span = previousWordFrom(text, index);

      if (span === null) {
        break;
      }

      walked.push(at(span));
      index = span.start;
    }

    expect(walked).toEqual(['twice', 'folded', 'chart', 'well-worn', 'sailor\u2019s', 'The']);
  });

  it('skips the word the cursor is standing in rather than returning it again', () => {
    const inside = text.indexOf('chart') + 2;

    expect(at(nextWordFrom(text, inside))).toBe('folded');
    expect(at(previousWordFrom(text, inside))).toBe('well-worn');
  });

  it('stops at the ends of the page instead of wrapping', () => {
    expect(nextWordFrom(text, text.length)).toBeNull();
    expect(previousWordFrom(text, 0)).toBeNull();
  });

  it('finds the last word when the page ends without punctuation', () => {
    // Regression: the end of the text sits inside the final word, which an
    // ordinary "previous word" step would skip.
    expect(at2('alpha', lastWordOf('alpha'))).toBe('alpha');
    expect(at2('first second', lastWordOf('first second'))).toBe('second');
    expect(at2('ends in a word\n', lastWordOf('ends in a word\n'))).toBe('word');
  });

  it('finds the first word when the page starts straight into one', () => {
    expect(at2('alpha', firstWordOf('alpha'))).toBe('alpha');
    expect(at2('  padded start', firstWordOf('  padded start'))).toBe('padded');
  });

  it('reports nothing for a page with no words at all', () => {
    expect(firstWordOf('')).toBeNull();
    expect(firstWordOf('   \n  ')).toBeNull();
    expect(lastWordOf('—— ·· ——')).toBeNull();
    expect(wordOnEntry('', 'backward')).toBeNull();
  });

  it('crosses a line break like any other gap', () => {
    const lines = 'first line\nsecond line';

    expect(at2(lines, nextWordFrom(lines, lines.indexOf('line')))).toBe('second');
  });
});

const at2 = (source: string, span: { start: number; end: number } | null): string | null =>
  span === null ? null : source.slice(span.start, span.end);
