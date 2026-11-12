import type { SavedWord } from './types';

/**
 * Turns saved words into a file a reader can take elsewhere.
 *
 * Two formats, both plain text:
 *
 * - **CSV** for a spreadsheet: one row per saved word, with a header row.
 * - **Anki**: tab-separated notes with Anki's file headers, so the file
 *   imports as Front / Back / Context / Source without any setup.
 *
 * Pure: the words go in, the text comes out. Choosing a file and writing
 * it belong to the main process.
 *
 * The words come from PDFs the reader opened, so nothing here is trusted
 * to be harmless in someone else's program. A CSV cell that a spreadsheet
 * would run as a formula is neutralised, and a field that would break out
 * of its row is quoted or flattened.
 */

export const VOCABULARY_EXPORT_FORMATS = ['csv', 'anki'] as const;

export type VocabularyExportFormat = (typeof VOCABULARY_EXPORT_FORMATS)[number];

export const parseVocabularyExportFormat = (raw: unknown): VocabularyExportFormat | null =>
  VOCABULARY_EXPORT_FORMATS.find((format) => format === raw) ?? null;

export const VOCABULARY_EXPORT_EXTENSION: Readonly<Record<VocabularyExportFormat, string>> = {
  csv: 'csv',
  anki: 'txt',
};

interface ExportRow {
  readonly word: string;
  readonly dictionaryForm: string;
  readonly partOfSpeech: string;
  readonly definition: string;
  readonly context: string;
  readonly document: string;
  readonly page: string;
  readonly saved: string;
}

const flatten = (text: string): string => text.replace(/\s+/gu, ' ').trim();

const rowFor = (saved: SavedWord): ExportRow => {
  // The place the word was first saved from: the oldest occurrence.
  const first = [...saved.occurrences].sort((a, b) => a.savedAt.localeCompare(b.savedAt))[0];
  const sense = saved.snapshot?.senses[0];

  return {
    word: flatten(saved.word.display),
    dictionaryForm: flatten(saved.headword ?? ''),
    partOfSpeech: flatten(sense?.partOfSpeech ?? ''),
    definition: flatten(saved.shortDefinition ?? sense?.definition ?? ''),
    context: flatten(first?.context ?? ''),
    document: flatten(first?.documentName ?? ''),
    page: first === undefined ? '' : String(first.page),
    saved: saved.savedAt.slice(0, 10),
  };
};

/**
 * A spreadsheet treats a cell that starts with one of these as a formula.
 * A leading apostrophe makes it text, and is what spreadsheets themselves
 * suggest for the purpose.
 */
const neutraliseFormula = (cell: string): string =>
  /^[=+\-@\t\r]/u.test(cell) ? `'${cell}` : cell;

const csvCell = (text: string): string => {
  const cell = neutraliseFormula(text);

  return /[",\r\n]/u.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
};

const CSV_HEADER = [
  'Word',
  'Dictionary form',
  'Part of speech',
  'Definition',
  'Context',
  'Document',
  'Page',
  'Saved',
];

/** The byte-order mark is what makes Excel read the file as UTF-8. */
const BYTE_ORDER_MARK = '\uFEFF';

const toCsv = (rows: readonly ExportRow[]): string => {
  const lines = [
    CSV_HEADER.join(','),
    ...rows.map((row) =>
      [
        row.word,
        row.dictionaryForm,
        row.partOfSpeech,
        row.definition,
        row.context,
        row.document,
        row.page,
        row.saved,
      ]
        .map(csvCell)
        .join(','),
    ),
  ];

  return `${BYTE_ORDER_MARK}${lines.join('\r\n')}\r\n`;
};

const toAnki = (rows: readonly ExportRow[]): string => {
  const lines = [
    '#separator:tab',
    '#html:false',
    '#columns:Front\tBack\tContext\tSource',
    ...rows.map((row) => {
      const front = row.dictionaryForm === '' ? row.word : row.dictionaryForm;
      const back =
        row.partOfSpeech === '' || row.definition === ''
          ? row.definition
          : `(${row.partOfSpeech}) ${row.definition}`;
      const source =
        row.document === ''
          ? ''
          : row.page === ''
            ? row.document
            : `${row.document}, p. ${row.page}`;

      // `flatten` has already removed every tab and line break.
      return [front, back, row.context, source].join('\t');
    }),
  ];

  return `${lines.join('\n')}\n`;
};

export const formatVocabularyExport = (
  words: readonly SavedWord[],
  format: VocabularyExportFormat,
): string => {
  const rows = words.map(rowFor);

  return format === 'csv' ? toCsv(rows) : toAnki(rows);
};

/** `lexleaf-vocabulary-2026-11-12.csv` */
export const vocabularyExportFileName = (format: VocabularyExportFormat, now: Date): string =>
  `lexleaf-vocabulary-${now.toISOString().slice(0, 10)}.${VOCABULARY_EXPORT_EXTENSION[format]}`;

/** What the reader is told afterwards. Carries no path and no words. */
export type VocabularyExportOutcome =
  | { readonly status: 'exported'; readonly count: number }
  | { readonly status: 'cancelled' }
  | { readonly status: 'empty' }
  | { readonly status: 'failed' };

export const parseVocabularyExportOutcome = (raw: unknown): VocabularyExportOutcome => {
  if (typeof raw === 'object' && raw !== null) {
    const { status, count } = raw as { status?: unknown; count?: unknown };

    if (
      status === 'exported' &&
      typeof count === 'number' &&
      Number.isInteger(count) &&
      count > 0
    ) {
      return { status: 'exported', count };
    }

    if (status === 'cancelled' || status === 'empty') {
      return { status };
    }
  }

  return { status: 'failed' };
};
