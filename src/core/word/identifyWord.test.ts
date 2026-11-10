import { describe, expect, it } from 'vitest';

import { identifyWordAt, joinSegments } from './identifyWord';
import type { TextSegment } from './types';

const line = (text: string): TextSegment => ({ text, endsLine: true });
const run = (text: string): TextSegment => ({ text, endsLine: false });

describe('joinSegments', () => {
  it('concatenates runs on the same line without adding separators', () => {
    const joined = joinSegments([run('obser'), run('ver'), run(' '), line('moves')]);

    expect(joined.text).toBe('observer moves\n');
    expect(joined.segmentStarts).toEqual([0, 5, 8, 9]);
  });

  it('separates visual lines so adjacent words never merge', () => {
    const joined = joinSegments([line('time'), line('until')]);

    expect(joined.text).toBe('time\nuntil\n');
  });
});

describe('identifyWordAt', () => {
  it('identifies a word inside a single run', () => {
    const word = identifyWordAt([line('The quick brown fox')], { segmentIndex: 0, charOffset: 11 });

    expect(word).toMatchObject({ raw: 'brown', display: 'brown', normalized: 'brown' });
    expect(word?.joinedAcrossLines).toBe(false);
  });

  it('assembles a word split across several runs on one line', () => {
    // Justified text makes PDF.js emit one run per word, and sometimes per
    // fragment, with separate runs for the spaces between them.
    const segments = [run('station'), run('ary'), run(' '), line('observer')];

    expect(identifyWordAt(segments, { segmentIndex: 0, charOffset: 3 })?.raw).toBe('stationary');
    expect(identifyWordAt(segments, { segmentIndex: 1, charOffset: 1 })?.raw).toBe('stationary');
  });

  it('does not merge the last word of a line with the first of the next', () => {
    const segments = [line('time'), line('until')];

    expect(identifyWordAt(segments, { segmentIndex: 0, charOffset: 2 })?.raw).toBe('time');
    expect(identifyWordAt(segments, { segmentIndex: 1, charOffset: 2 })?.raw).toBe('until');
  });

  it('returns null when the pointer is over a space run', () => {
    const segments = [run('one'), run('   '), line('two')];

    expect(identifyWordAt(segments, { segmentIndex: 1, charOffset: 2 })).toBeNull();
  });

  it('returns null when the pointer is over punctuation only', () => {
    expect(identifyWordAt([line('\u2014 \u2014')], { segmentIndex: 0, charOffset: 2 })).toBeNull();
  });

  it('returns null for an unknown segment', () => {
    expect(identifyWordAt([line('text')], { segmentIndex: 7, charOffset: 0 })).toBeNull();
    expect(identifyWordAt([], { segmentIndex: 0, charOffset: 0 })).toBeNull();
  });

  it('clamps an offset beyond the end of its run', () => {
    expect(identifyWordAt([line('word')], { segmentIndex: 0, charOffset: 99 })?.raw).toBe('word');
  });

  describe('words broken across a line break', () => {
    const segments = [line('the matter was recon-'), line('sidered by the board')];

    it('rejoins the word when the first half is clicked', () => {
      const word = identifyWordAt(segments, { segmentIndex: 0, charOffset: 17 });

      expect(word).toMatchObject({
        raw: 'recon-\nsidered',
        display: 'recon-sidered',
        normalized: 'reconsidered',
        joinedAcrossLines: true,
      });
    });

    it('rejoins the word when the second half is clicked', () => {
      const word = identifyWordAt(segments, { segmentIndex: 1, charOffset: 3 });

      expect(word).toMatchObject({ display: 'recon-sidered', normalized: 'reconsidered' });
      expect(word?.joinedAcrossLines).toBe(true);
    });

    it('leaves a hyphenated compound inside a line untouched', () => {
      const compound = [line('a well-known case')];

      expect(identifyWordAt(compound, { segmentIndex: 0, charOffset: 4 })).toMatchObject({
        display: 'well-known',
        normalized: 'well-known',
        joinedAcrossLines: false,
      });
    });

    it('does not rejoin when the next line starts with punctuation', () => {
      const dashEnded = [line('an em dash \u2014'), line('; continues')];

      expect(identifyWordAt(dashEnded, { segmentIndex: 0, charOffset: 8 })?.raw).toBe('dash');
    });
  });

  it('keeps the raw text and the lookup form separate', () => {
    const word = identifyWordAt([line('He said \u201CAmbivalence,\u201D again')], {
      segmentIndex: 0,
      charOffset: 12,
    });

    expect(word?.raw).toBe('Ambivalence');
    expect(word?.normalized).toBe('ambivalence');
  });
});
