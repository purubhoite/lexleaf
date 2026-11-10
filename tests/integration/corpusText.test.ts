import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OpenedPdf, PdfEngine } from '../../src/core/pdf/pdfEngine';
import { identifyWordAt } from '../../src/core/word/identifyWord';
import type { IdentifiedWord, TextSegment } from '../../src/core/word/types';
import { createNodeEngine, locationOfIndex, pageText, readFixture } from './support/corpus';

/**
 * Category-by-category behaviour of the real engine over the committed
 * corpus. Each test states what the category is meant to prove.
 */

let engine: PdfEngine;
const opened: OpenedPdf[] = [];

const open = async (fixture: string, password?: string): Promise<OpenedPdf> => {
  const bytes = await readFixture(fixture);
  const result = await engine.open(
    password === undefined ? { bytes, label: fixture } : { bytes, label: fixture, password },
  );

  if (!result.ok) {
    throw new Error(`${fixture} did not open: ${result.error.cause}`);
  }
  opened.push(result.value);
  return result.value;
};

const segmentsOf = async (fixture: string, pageNumber = 1): Promise<readonly TextSegment[]> =>
  (await (await open(fixture)).getPageText(pageNumber)).segments;

interface Aim {
  /** Which occurrence of the phrase to use (0 based). */
  readonly occurrence?: number;
  /** Where inside the phrase to aim; the middle by default. */
  readonly offset?: number;
}

/** Identifies the word at a chosen point inside a known phrase occurrence. */
const identifyIn = (
  segments: readonly TextSegment[],
  needle: string,
  aim: Aim = {},
): IdentifiedWord | null => {
  const text = pageText(segments);
  let index = -1;

  for (let seen = 0; seen <= (aim.occurrence ?? 0); seen += 1) {
    index = text.indexOf(needle, index + 1);
    if (index < 0) {
      throw new Error(`"${needle}" is not present in the page text`);
    }
  }

  const offset = aim.offset ?? Math.floor(needle.length / 2);
  return identifyWordAt(segments, locationOfIndex(segments, index + offset));
};

beforeAll(async () => {
  engine = await createNodeEngine();
});

afterAll(async () => {
  await Promise.all(opened.map(async (document) => document.close()));
});

describe('A — standard prose', () => {
  it('identifies an ordinary word', async () => {
    const segments = await segmentsOf('a-standard-prose');

    expect(identifyIn(segments, 'harbour')).toMatchObject({
      raw: 'harbour',
      normalized: 'harbour',
    });
  });

  it('does not merge the last word of a line with the first word of the next', async () => {
    const segments = await segmentsOf('a-standard-prose');

    // The source line ends "…at a time, until" and the next begins "only…".
    expect(identifyIn(segments, 'until')).toMatchObject({ raw: 'until' });
    expect(identifyIn(segments, 'only')).toMatchObject({ raw: 'only' });
    expect(pageText(segments)).toContain('until\nonly');
  });
});

describe('B — multi-column layout', () => {
  it('assembles words although the engine emits one run per word', async () => {
    const segments = await segmentsOf('b-multi-column');

    expect(segments.length).toBeGreaterThan(100);
    expect(identifyIn(segments, 'observer')).toMatchObject({ raw: 'observer' });
    expect(identifyIn(segments, 'atmospheric')).toMatchObject({ raw: 'atmospheric' });
  });

  it('keeps the two columns separate', async () => {
    const segments = await segmentsOf('b-multi-column');

    // The same paragraph appears in both columns; both occurrences resolve.
    expect(identifyIn(segments, 'stationary', { occurrence: 0 })).toMatchObject({
      raw: 'stationary',
    });
    expect(identifyIn(segments, 'stationary', { occurrence: 1 })).toMatchObject({
      raw: 'stationary',
    });
  });
});

describe('C — justified text', () => {
  it('identifies words despite variable word spacing', async () => {
    const segments = await segmentsOf('c-justified');

    expect(identifyIn(segments, 'mainland')).toMatchObject({ raw: 'mainland' });
  });
});

describe('D — mixed font sizes', () => {
  it('identifies words at the smallest and the largest size', async () => {
    const segments = await segmentsOf('d-font-sizes');

    expect(identifyIn(segments, '7 points', { offset: 0 })).toMatchObject({ raw: '7' });
    expect(identifyIn(segments, 'luminous')).toMatchObject({ raw: 'luminous' });
    expect(identifyIn(segments, 'Measurement', { occurrence: 5 })).toMatchObject({
      raw: 'Measurement',
    });
  });
});

describe('E — punctuation', () => {
  it('excludes the surrounding punctuation from the word', async () => {
    const segments = await segmentsOf('e-punctuation');
    const text = pageText(segments);
    const wrappers = text.split('\n').filter((line) => line.includes('ambivalence'));

    expect(wrappers.length).toBeGreaterThanOrEqual(13);

    for (const [index] of wrappers.entries()) {
      const word = identifyIn(segments, 'ambivalence', { occurrence: index });

      expect(word?.raw).toBe('ambivalence');
      expect(word?.normalized).toBe('ambivalence');
    }
  });
});

describe('F — hyphenation', () => {
  it('rejoins a word broken across a line break', async () => {
    const segments = await segmentsOf('f-hyphenation');

    expect(identifyIn(segments, 'recon-')).toMatchObject({
      display: 'recon-sidered',
      normalized: 'reconsidered',
      joinedAcrossLines: true,
    });
    expect(identifyIn(segments, 'sidered the')).toMatchObject({
      display: 'recon-sidered',
      joinedAcrossLines: true,
    });
  });

  it('keeps genuine compounds intact', async () => {
    const segments = await segmentsOf('f-hyphenation');

    expect(identifyIn(segments, 'well-known')).toMatchObject({
      raw: 'well-known',
      joinedAcrossLines: false,
    });
    expect(identifyIn(segments, 'state-of-the-art')).toMatchObject({ raw: 'state-of-the-art' });
  });

  it('does not join across an em dash', async () => {
    const segments = await segmentsOf('f-hyphenation');

    expect(identifyIn(segments, 'pause')).toMatchObject({ raw: 'pause' });
  });
});

describe('G — apostrophes', () => {
  it('keeps contractions and possessives together', async () => {
    const segments = await segmentsOf('g-apostrophes');

    expect(identifyIn(segments, "don't")).toMatchObject({ raw: "don't", normalized: "don't" });
    expect(identifyIn(segments, "author's")).toMatchObject({ raw: "author's" });
    expect(identifyIn(segments, "o'clock")).toMatchObject({ raw: "o'clock" });
  });

  it('drops a trailing possessive apostrophe from the lookup form', async () => {
    const segments = await segmentsOf('g-apostrophes');

    expect(identifyIn(segments, "users'")).toMatchObject({ raw: 'users', normalized: 'users' });
  });

  it('identifies a word wrapped in quotation marks', async () => {
    const segments = await segmentsOf('g-apostrophes');

    expect(identifyIn(segments, "'quoted'")).toMatchObject({ raw: 'quoted' });
  });
});

describe('H — ligatures and Unicode', () => {
  it('reports ligatures as ordinary letters', async () => {
    const segments = await segmentsOf('h-ligatures-unicode');

    // PDF.js already maps the ligature glyphs back to their letters.
    expect(identifyIn(segments, 'find')).toMatchObject({ raw: 'find', normalized: 'find' });
    expect(identifyIn(segments, 'flourish')).toMatchObject({ normalized: 'flourish' });
  });

  it('preserves diacritics and normalises curly quotes away', async () => {
    const segments = await segmentsOf('h-ligatures-unicode');

    expect(identifyIn(segments, 'caf\u00E9')).toMatchObject({ normalized: 'caf\u00E9' });
    expect(identifyIn(segments, 'Gr\u00FC\u00DFe')).toMatchObject({
      normalized: 'gr\u00FC\u00DFe',
    });
    expect(identifyIn(segments, '\u201Cambivalence\u201D')).toMatchObject({ raw: 'ambivalence' });
  });
});

describe('I — headers and footers', () => {
  it('identifies words in the header, the body and the footer', async () => {
    const document = await open('i-headers-footers');
    const { segments } = await document.getPageText(2);

    expect(identifyIn(segments, 'HARBOUR')).toMatchObject({
      raw: 'HARBOUR',
      normalized: 'harbour',
    });
    expect(identifyIn(segments, 'lighthouse')).toMatchObject({ raw: 'lighthouse' });
    expect(identifyIn(segments, 'page 2 of 3', { offset: 1 })).toMatchObject({ raw: 'page' });
  });
});

describe('J — footnotes', () => {
  it('identifies words in the footnote block', async () => {
    const segments = await segmentsOf('j-footnotes');

    expect(identifyIn(segments, 'appendix')).toMatchObject({ raw: 'appendix' });
    expect(identifyIn(segments, 'timetable')).toMatchObject({ raw: 'timetable' });
  });

  it('does not attach a footnote marker to the preceding word', async () => {
    const segments = await segmentsOf('j-footnotes');

    expect(pageText(segments)).toContain('choices. 1');
    expect(identifyIn(segments, 'choices')).toMatchObject({ raw: 'choices' });
  });
});

describe('K — rotated pages', () => {
  it('extracts text from every rotation', async () => {
    const document = await open('k-rotated');

    expect(document.pageCount).toBe(4);

    // Pages 1 to 3 carry the same prose at 90, 180 and 270 degrees.
    for (const pageNumber of [1, 2, 3]) {
      const { segments, hasTextLayer } = await document.getPageText(pageNumber);

      expect(hasTextLayer).toBe(true);
      expect(identifyIn(segments, 'lighthouse')).toMatchObject({ raw: 'lighthouse' });
    }
  });

  it('extracts text from runs rotated within an upright page', async () => {
    const document = await open('k-rotated');
    const { segments } = await document.getPageText(4);

    expect(identifyIn(segments, 'ascending')).toMatchObject({ raw: 'ascending' });
    expect(identifyIn(segments, 'watermark')).toMatchObject({ raw: 'watermark' });
    expect(identifyIn(segments, 'upright')).toMatchObject({ raw: 'upright' });
  });

  it('reports the declared rotation of each page', async () => {
    const document = await open('k-rotated');

    expect((await document.getPageSize(1)).rotation).toBe(90);
    expect((await document.getPageSize(2)).rotation).toBe(180);
    expect((await document.getPageSize(3)).rotation).toBe(270);
  });
});

describe('L — unusual encodings', () => {
  it('round-trips non-Latin scripts', async () => {
    const segments = await segmentsOf('l-unusual-encoding');

    expect(
      identifyIn(segments, '\u03B1\u03BC\u03C6\u03B9\u03B2\u03BF\u03BB\u03AF\u03B1'),
    ).toMatchObject({ raw: '\u03B1\u03BC\u03C6\u03B9\u03B2\u03BF\u03BB\u03AF\u03B1' });
    expect(
      identifyIn(
        segments,
        '\u0434\u0432\u0443\u0441\u043C\u044B\u0441\u043B\u0435\u043D\u043D\u043E\u0441\u0442\u044C',
      ),
    ).toMatchObject({
      raw: '\u0434\u0432\u0443\u0441\u043C\u044B\u0441\u043B\u0435\u043D\u043D\u043E\u0441\u0442\u044C',
    });
    expect(identifyIn(segments, 'Vi\u1EC7t')).toMatchObject({
      raw: 'Vi\u1EC7t',
      normalized: 'vi\u1EC7t',
    });
    expect(identifyIn(segments, 'Stra\u00DFe')).toMatchObject({ normalized: 'stra\u00DFe' });
  });

  it('treats mathematical symbols as non-words', async () => {
    const segments = await segmentsOf('l-unusual-encoding');
    const text = pageText(segments);
    const location = locationOfIndex(segments, text.indexOf('\u2264'));

    expect(identifyWordAt(segments, location)).toBeNull();
  });
});

describe('Q — page without text', () => {
  it('opens and reports that there is nothing to interact with', async () => {
    const document = await open('q-empty-page');
    const page = await document.getPageText(1);

    expect(page.hasTextLayer).toBe(false);
    expect(page.segments).toHaveLength(0);
  });
});

describe('M7.5 — representative Unicode and CJK', () => {
  it('preserves horizontal Japanese, Chinese and mixed Latin text', async () => {
    const segments = await segmentsOf('r-cjk-mixed');
    const text = pageText(segments);

    expect(text).toContain('日本語の文章');
    expect(text).toContain('中文测试');
    expect(text).toContain('Mixed Latin and CJK.');
    expect(text).not.toContain('\uFFFD');
  });

  it('extracts combining marks, observed RTL sequences and an astral-plane character', async () => {
    const segments = await segmentsOf('s-unicode-representative');
    const text = pageText(segments);

    expect(text).toContain('e\u0301');
    expect(text).toContain('םולש');
    expect(text).toContain('ابحرم');
    expect(text).toContain('😀');
    expect(text).not.toContain('\u0000');
    expect(text).not.toContain('\uFFFD');
  });
});
