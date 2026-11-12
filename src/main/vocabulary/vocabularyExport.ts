import { LIBRARY_PAGE_SIZE } from '@core/vocabulary/search';
import {
  VOCABULARY_EXPORT_EXTENSION,
  formatVocabularyExport,
  vocabularyExportFileName,
  type VocabularyExportFormat,
  type VocabularyExportOutcome,
} from '@core/vocabulary/export';
import type { LibraryCursor, SavedWord } from '@core/vocabulary/types';

import type { VocabularyService } from './vocabularyService';

/**
 * Writes the saved words to a file the reader chooses.
 *
 * The renderer asks for a format and nothing else. Where the file goes is
 * decided in the system's own save window, shown by the main process, so
 * the page never names a path and never sees one: the answer it gets back
 * is a count, or that nothing was written.
 */

export interface VocabularyExportOptions {
  readonly service: Pick<VocabularyService, 'list'>;
  /** Shows the save window. Resolves to `null` when the reader cancels. */
  readonly chooseDestination: (
    suggestedName: string,
    format: VocabularyExportFormat,
  ) => Promise<string | null>;
  readonly write: (path: string, contents: string) => Promise<void>;
  readonly now: () => Date;
  readonly onDiagnostic: (message: string) => void;
}

/** A library far larger than any reader's, so a broken cursor cannot loop. */
const MAXIMUM_PAGES = 10_000;

const readAll = (service: Pick<VocabularyService, 'list'>): SavedWord[] | null => {
  const words: SavedWord[] = [];
  let cursor: LibraryCursor | null = null;

  for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
    const result = service.list({
      sort: 'alphabetical',
      documentId: null,
      cursor,
      limit: LIBRARY_PAGE_SIZE,
    });

    if (!result.ok) {
      return null;
    }

    words.push(...result.value.items);
    cursor = result.value.nextCursor;

    if (cursor === null) {
      return words;
    }
  }

  return null;
};

export const exportVocabulary = async (
  format: VocabularyExportFormat,
  { service, chooseDestination, write, now, onDiagnostic }: VocabularyExportOptions,
): Promise<VocabularyExportOutcome> => {
  const words = readAll(service);

  if (words === null) {
    onDiagnostic('the vocabulary could not be read for export');

    return { status: 'failed' };
  }

  if (words.length === 0) {
    // Nothing to write, so the reader is not asked where to write it.
    return { status: 'empty' };
  }

  const destination = await chooseDestination(vocabularyExportFileName(format, now()), format);

  if (destination === null) {
    return { status: 'cancelled' };
  }

  try {
    await write(destination, formatVocabularyExport(words, format));
  } catch (error) {
    onDiagnostic(
      `the vocabulary export could not be written: ${error instanceof Error ? error.name : 'unknown error'}`,
    );

    return { status: 'failed' };
  }

  onDiagnostic(`exported ${String(words.length)} saved words as ${format}`);

  return { status: 'exported', count: words.length };
};

export const VOCABULARY_EXPORT_FILTERS: Readonly<
  Record<VocabularyExportFormat, { readonly name: string; readonly extensions: string[] }>
> = {
  csv: { name: 'Spreadsheet (CSV)', extensions: [VOCABULARY_EXPORT_EXTENSION.csv] },
  anki: { name: 'Anki notes (text)', extensions: [VOCABULARY_EXPORT_EXTENSION.anki] },
};
