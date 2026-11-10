import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OpenedPdf, PdfEngine } from '../../src/core/pdf/pdfEngine';
import { identifyWordAt } from '../../src/core/word/identifyWord';
import type { TextSegment } from '../../src/core/word/types';
import { createNodeEngine, locationOfIndex, pageText, readFixture } from './support/corpus';

/**
 * A sweep over the corpus: every word of every page is aimed at and the
 * identified word is compared with an expectation derived independently of
 * the boundary rules.
 *
 * The oracle splits the page text on whitespace and trims punctuation from
 * the ends of each token. Tokens that whitespace splitting cannot resolve on
 * its own (internal full stops, dashes, a hyphen at a line break) are skipped
 * here and covered by the targeted tests in corpusText.test.ts.
 */

/** Characters that may legitimately appear inside a single word. */
const SIMPLE_TOKEN = /^[\p{L}\p{N}\p{M}'\u2019-]+$/u;
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

interface Token {
  readonly expected: string;
  readonly start: number;
}

const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  const pattern = /\S+/gu;
  let match = pattern.exec(text);

  while (match !== null) {
    const raw = match[0];
    const trimmed = raw.replace(EDGE_PUNCTUATION, '');
    const offset = raw.indexOf(trimmed);

    // A hyphen at the end of a line means the word continues on the next
    // one; neither half is a word on its own, so both are left to the
    // targeted hyphenation tests.
    const start = match.index;
    const endsWithLineBreakHyphen = raw.endsWith('-') && text[start + raw.length] === '\n';
    const continuesPreviousLine =
      text[start - 1] === '\n' && /[-\u2010\u2011]/u.test(text[start - 2] ?? '');

    if (
      trimmed !== '' &&
      SIMPLE_TOKEN.test(trimmed) &&
      !endsWithLineBreakHyphen &&
      !continuesPreviousLine
    ) {
      tokens.push({ expected: trimmed, start: start + offset });
    }
    match = pattern.exec(text);
  }

  return tokens;
};

/**
 * @returns a description of every mismatch, so a failure names the words
 */
const sweep = (segments: readonly TextSegment[], everyOffset: boolean): string[] => {
  const text = pageText(segments);
  const problems: string[] = [];

  for (const token of tokenize(text)) {
    const offsets = everyOffset
      ? Array.from({ length: token.expected.length }, (_, offset) => offset)
      : [Math.floor(token.expected.length / 2)];

    for (const offset of offsets) {
      const word = identifyWordAt(segments, locationOfIndex(segments, token.start + offset));

      if (word?.raw !== token.expected) {
        problems.push(
          `"${token.expected}" at offset ${offset} resolved to ${JSON.stringify(word?.raw)}`,
        );
      }
    }
  }

  return problems;
};

const SMALL_FIXTURES = [
  'a-standard-prose',
  'b-multi-column',
  'c-justified',
  'd-font-sizes',
  'e-punctuation',
  'f-hyphenation',
  'g-apostrophes',
  'h-ligatures-unicode',
  'j-footnotes',
  'l-unusual-encoding',
] as const;

const MULTI_PAGE_FIXTURES = [
  { fixture: 'i-headers-footers', pages: [1, 2, 3] },
  { fixture: 'k-rotated', pages: [1, 2, 3, 4] },
] as const;

let engine: PdfEngine;
const opened: OpenedPdf[] = [];

const open = async (fixture: string): Promise<OpenedPdf> => {
  const result = await engine.open({ bytes: await readFixture(fixture), label: fixture });

  if (!result.ok) {
    throw new Error(`${fixture} did not open: ${result.error.cause}`);
  }
  opened.push(result.value);
  return result.value;
};

beforeAll(async () => {
  engine = await createNodeEngine();
});

afterAll(async () => {
  await Promise.all(opened.map(async (document) => document.close()));
});

describe('every word on a page can be identified', () => {
  it.each(SMALL_FIXTURES)('%s — from every character offset', async (fixture) => {
    const document = await open(fixture);
    const { segments } = await document.getPageText(1);

    expect(sweep(segments, true)).toEqual([]);
  });

  it.each(MULTI_PAGE_FIXTURES)('$fixture — on every page', async ({ fixture, pages }) => {
    const document = await open(fixture);

    for (const pageNumber of pages) {
      const { segments } = await document.getPageText(pageNumber);

      expect(sweep(segments, true), `page ${pageNumber}`).toEqual([]);
    }
  });

  it('m-large — on the first, a middle and the last page', async () => {
    const document = await open('m-large');

    for (const pageNumber of [1, 200, document.pageCount]) {
      const { segments } = await document.getPageText(pageNumber);

      expect(sweep(segments, false), `page ${pageNumber}`).toEqual([]);
    }
  });

  it('covers a meaningful number of words', async () => {
    const document = await open('a-standard-prose');
    const { segments } = await document.getPageText(1);

    expect(tokenize(pageText(segments)).length).toBeGreaterThan(80);
  });
});
