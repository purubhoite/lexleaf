import { describe, expect, it } from 'vitest';

import {
  formatVocabularyExport,
  parseVocabularyExportFormat,
  parseVocabularyExportOutcome,
  vocabularyExportFileName,
} from './export';
import type { SavedOccurrence, SavedWord } from './types';

const occurrence = (overrides: Partial<SavedOccurrence> = {}): SavedOccurrence => ({
  documentId: 'doc-1',
  documentName: 'The Harbour.pdf',
  documentPath: '/books/harbour.pdf',
  page: 12,
  charStart: null,
  charEnd: null,
  pageOffsetFraction: null,
  context: 'the ships lay at anchor in the roadstead',
  contextWordStart: null,
  savedAt: '2026-11-10T09:00:00.000Z',
  ...overrides,
});

const word = (overrides: Partial<SavedWord> = {}): SavedWord => ({
  id: 'item-1',
  word: { raw: 'ships', display: 'ships', normalized: 'ships', joinedAcrossLines: false },
  headword: 'ship',
  resolvedBy: null,
  lookupStatus: 'found',
  shortDefinition: 'a large vessel that travels on water',
  snapshot: {
    senses: [
      {
        partOfSpeech: 'noun',
        definition: 'a large vessel that travels on water',
        examples: [],
        synonyms: [],
        source: 'wordnet',
      } as never,
    ],
    pronunciations: [],
    alsoInflectionOf: [],
  },
  source: null,
  occurrences: [occurrence()],
  savedAt: '2026-11-10T09:00:00.000Z',
  occurrenceCount: 1,
  ...overrides,
});

describe('the CSV export', () => {
  it('writes a header and one row per word, readable by Excel', () => {
    const csv = formatVocabularyExport([word()], 'csv');

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toStrictEqual([
      'Word,Dictionary form,Part of speech,Definition,Context,Document,Page,Saved',
      'ships,ship,noun,a large vessel that travels on water,the ships lay at anchor in the roadstead,The Harbour.pdf,12,2026-11-10',
      '',
    ]);
  });

  it('quotes commas, quotes and line breaks', () => {
    const csv = formatVocabularyExport(
      [
        word({
          shortDefinition: 'a vessel, large; called a "ship"',
          occurrences: [occurrence({ context: 'first line\nsecond line' })],
        }),
      ],
      'csv',
    );

    expect(csv).toContain('"a vessel, large; called a ""ship"""');
    // Line breaks inside a field are flattened, so a row is always a line.
    expect(csv).toContain('first line second line');
    expect(csv.trimEnd().split('\r\n')).toHaveLength(2);
  });

  it('does not let a cell be run as a spreadsheet formula', () => {
    const csv = formatVocabularyExport(
      [
        word({
          word: { raw: '=1+1', display: '=1+1', normalized: '=1+1', joinedAcrossLines: false },
          headword: '@SUM(A1)',
          shortDefinition: '+cmd|calc',
          occurrences: [occurrence({ context: '-2+3', documentName: '=HYPERLINK("x")' })],
        }),
      ],
      'csv',
    );
    const cells = csv.trimEnd().split('\r\n')[1] ?? '';

    expect(cells).toContain("'=1+1,'@SUM(A1),");
    expect(cells).toContain("'+cmd|calc,'-2+3,");
    expect(cells).toContain('"\'=HYPERLINK(""x"")"');
  });

  it('leaves blanks for what a word does not have', () => {
    const csv = formatVocabularyExport(
      [word({ headword: null, shortDefinition: null, snapshot: null, occurrences: [] })],
      'csv',
    );

    expect(csv.trimEnd().split('\r\n')[1]).toBe('ships,,,,,,,2026-11-10');
  });

  it('uses the place the word was first saved from', () => {
    const csv = formatVocabularyExport(
      [
        word({
          occurrences: [
            occurrence({ page: 40, savedAt: '2026-11-12T09:00:00.000Z', context: 'later' }),
            occurrence({ page: 3, savedAt: '2026-11-09T09:00:00.000Z', context: 'earlier' }),
          ],
        }),
      ],
      'csv',
    );

    expect(csv).toContain(',earlier,The Harbour.pdf,3,');
  });
});

describe('the Anki export', () => {
  it('writes Anki headers and tab-separated notes', () => {
    expect(formatVocabularyExport([word()], 'anki').split('\n')).toStrictEqual([
      '#separator:tab',
      '#html:false',
      '#columns:Front\tBack\tContext\tSource',
      'ship\t(noun) a large vessel that travels on water\tthe ships lay at anchor in the roadstead\tThe Harbour.pdf, p. 12',
      '',
    ]);
  });

  it('falls back to the word as it was read, and keeps a note to one line', () => {
    const anki = formatVocabularyExport(
      [
        word({
          headword: null,
          snapshot: null,
          shortDefinition: 'a\tvessel\r\nof size',
          occurrences: [],
        }),
      ],
      'anki',
    );

    expect(anki.split('\n')[3]).toBe('ships\ta vessel of size\t\t');
  });

  it('writes only the headers for an empty library', () => {
    expect(formatVocabularyExport([], 'anki').trimEnd().split('\n')).toHaveLength(3);
  });
});

describe('the export file name', () => {
  it('carries the date and the right extension', () => {
    const now = new Date('2026-11-12T08:00:00.000Z');

    expect(vocabularyExportFileName('csv', now)).toBe('lexleaf-vocabulary-2026-11-12.csv');
    expect(vocabularyExportFileName('anki', now)).toBe('lexleaf-vocabulary-2026-11-12.txt');
  });
});

describe('what crosses the bridge', () => {
  it('accepts only the two formats', () => {
    expect(parseVocabularyExportFormat('csv')).toBe('csv');
    expect(parseVocabularyExportFormat('anki')).toBe('anki');

    for (const raw of ['json', 'CSV', '', null, 3, { format: 'csv' }, '/tmp/out.csv']) {
      expect(parseVocabularyExportFormat(raw)).toBeNull();
    }
  });

  it('reads an outcome, and calls anything unexpected a failure', () => {
    expect(parseVocabularyExportOutcome({ status: 'exported', count: 12 })).toStrictEqual({
      status: 'exported',
      count: 12,
    });
    expect(
      parseVocabularyExportOutcome({ status: 'exported', count: 12, path: '/home/reader/x.csv' }),
    ).toStrictEqual({ status: 'exported', count: 12 });
    expect(parseVocabularyExportOutcome({ status: 'cancelled' })).toStrictEqual({
      status: 'cancelled',
    });
    expect(parseVocabularyExportOutcome({ status: 'empty' })).toStrictEqual({ status: 'empty' });

    for (const raw of [
      null,
      'exported',
      { status: 'exported' },
      { status: 'exported', count: 0 },
      { status: 'exported', count: 1.5 },
      { ok: false, error: { kind: 'unavailable' } },
    ]) {
      expect(parseVocabularyExportOutcome(raw)).toStrictEqual({ status: 'failed' });
    }
  });
});
