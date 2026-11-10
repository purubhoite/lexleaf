import type {
  DictionaryAttribution,
  DictionaryLicence,
  DictionaryPartOfSpeech,
  DictionaryPronunciation,
  DictionaryResolution,
  DictionarySenseSource,
} from '../dictionary/types';

import { MAX_CONTEXT_CHARACTERS } from './context';
import type {
  SavedDictionarySnapshot,
  SavedDictionarySource,
  SavedLookupStatus,
  SavedOccurrence,
  SavedSense,
  SavedWord,
} from './types';

/**
 * Reading the store back.
 *
 * Stored data is input, not memory — a database file can be edited, written
 * by a newer build, or damaged by a failing disk — so rows are parsed field
 * by field exactly as `src/core/persistence/schema.ts` parses the reader
 * state. The difference from that store is the consequence of failure: a
 * reader's saved words cannot be rebuilt by doing anything again, so a row
 * that does not validate is **skipped and counted, never repaired and never
 * deleted**. The library says how many rows it could not read and leaves
 * them on disk for a later version to rescue.
 */

/** A row as a driver hands it over: column names to unknown values. */
export type StoredRow = Readonly<Record<string, unknown>>;

const LOOKUP_STATUSES: readonly SavedLookupStatus[] = ['found', 'partial', 'not-found'];

const RESOLUTIONS: readonly DictionaryResolution[] = [
  'exact',
  'case',
  'typographic',
  'morphology',
  'closed-class',
];

const PARTS_OF_SPEECH: readonly DictionaryPartOfSpeech[] = [
  'noun',
  'verb',
  'adjective',
  'adverb',
  'determiner',
  'pronoun',
  'preposition',
  'conjunction',
  'auxiliary verb',
  'particle',
];

const SENSE_SOURCES: readonly DictionarySenseSource[] = ['wordnet', 'application'];

const VARIETIES: readonly DictionaryPronunciation['variety'][] = ['US', 'GB', 'unspecified'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const asOptionalText = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const asInteger = (value: unknown): number | null => {
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : null;
  }

  return typeof value === 'number' && Number.isInteger(value) ? value : null;
};

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asStringList = (value: unknown): readonly string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const items: string[] = [];

  for (const entry of value) {
    if (typeof entry !== 'string') {
      return null;
    }

    items.push(entry);
  }

  return items;
};

const parseSense = (value: unknown): SavedSense | null => {
  if (!isObject(value)) {
    return null;
  }

  const partOfSpeech = PARTS_OF_SPEECH.find((candidate) => candidate === value['partOfSpeech']);
  const definition = asText(value['definition']);
  const examples = asStringList(value['examples']);
  const synonyms = asStringList(value['synonyms']);
  const source = SENSE_SOURCES.find((candidate) => candidate === value['source']);

  if (
    partOfSpeech === undefined ||
    definition === null ||
    examples === null ||
    synonyms === null ||
    source === undefined
  ) {
    return null;
  }

  return { partOfSpeech, definition, examples, synonyms, source };
};

const parsePronunciation = (value: unknown): DictionaryPronunciation | null => {
  if (!isObject(value)) {
    return null;
  }

  const pronunciation = asText(value['value']);
  const variety = VARIETIES.find((candidate) => candidate === value['variety']);

  if (pronunciation === null || variety === undefined) {
    return null;
  }

  return { value: pronunciation, variety };
};

/** Parses the one JSON column: the answer the popup showed. */
export const parseSnapshot = (value: unknown): SavedDictionarySnapshot | null => {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  let document: unknown;

  try {
    document = JSON.parse(value);
  } catch {
    return null;
  }

  if (!isObject(document)) {
    return null;
  }

  const rawSenses = document['senses'];
  const rawPronunciations = document['pronunciations'];

  if (!Array.isArray(rawSenses) || !Array.isArray(rawPronunciations)) {
    return null;
  }

  const senses: SavedSense[] = [];

  for (const candidate of rawSenses) {
    const sense = parseSense(candidate);

    if (sense === null) {
      return null;
    }

    senses.push(sense);
  }

  const pronunciations: DictionaryPronunciation[] = [];

  for (const candidate of rawPronunciations) {
    const pronunciation = parsePronunciation(candidate);

    if (pronunciation === null) {
      return null;
    }

    pronunciations.push(pronunciation);
  }

  const alsoInflectionOf = asStringList(document['alsoInflectionOf']) ?? [];

  return { senses, pronunciations, alsoInflectionOf };
};

const parseLicences = (value: unknown): readonly DictionaryLicence[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const licences: DictionaryLicence[] = [];

  for (const candidate of value) {
    if (!isObject(candidate)) {
      return null;
    }

    const name = asText(candidate['name']);
    const url = asText(candidate['url']);

    if (name === null || url === null) {
      return null;
    }

    licences.push({ name, url });
  }

  return licences;
};

export const parseAttribution = (value: unknown): DictionaryAttribution | null => {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  let document: unknown;

  try {
    document = JSON.parse(value);
  } catch {
    return null;
  }

  if (!isObject(document)) {
    return null;
  }

  const datasetName = asText(document['datasetName']);
  const release = asText(document['release']);
  const licences = parseLicences(document['licences']);
  const modificationStatement = asOptionalText(document['modificationStatement']);
  const credits = asStringList(document['credits']);

  if (
    datasetName === null ||
    release === null ||
    licences === null ||
    modificationStatement === null ||
    credits === null ||
    typeof document['modified'] !== 'boolean'
  ) {
    return null;
  }

  return {
    datasetName,
    release,
    licences,
    modified: document['modified'],
    modificationStatement,
    credits,
  };
};

/** The dictionary version a snapshot was taken from, as stored. */
export const parseSource = (row: StoredRow): SavedDictionarySource | null => {
  const provider = asText(row['provider']);
  const datasetName = asText(row['dataset_name']);
  const datasetRelease = asText(row['dataset_release']);
  const transformVersion = asText(row['transform_version']);
  const attribution = parseAttribution(row['attribution_json']);

  if (
    provider === null ||
    datasetName === null ||
    datasetRelease === null ||
    transformVersion === null ||
    attribution === null
  ) {
    return null;
  }

  return { provider, datasetName, datasetRelease, transformVersion, attribution };
};

/**
 * One place a word was met.
 *
 * The anchor is validated as a pair: a half-anchor cannot be stored (the
 * schema rejects it) and is not accepted on the way out either.
 */
export const parseOccurrenceRow = (row: StoredRow): SavedOccurrence | null => {
  const documentId = asText(row['document_id']);
  const documentName = asText(row['document_name']);
  const page = asInteger(row['page']);
  const savedAt = asText(row['created_at']);

  if (
    documentId === null ||
    documentName === null ||
    page === null ||
    page < 1 ||
    savedAt === null
  ) {
    return null;
  }

  const charStart = asInteger(row['char_start']);
  const charEnd = asInteger(row['char_end']);

  if ((charStart === null) !== (charEnd === null)) {
    return null;
  }

  if (charStart !== null && charEnd !== null && (charStart < 0 || charEnd <= charStart)) {
    return null;
  }

  const context = asOptionalText(row['context']);

  if (context !== null && context.length > MAX_CONTEXT_CHARACTERS) {
    return null;
  }

  return {
    documentId,
    documentName,
    documentPath: asOptionalText(row['last_known_path']),
    page,
    charStart,
    charEnd,
    pageOffsetFraction: asNumber(row['page_offset_fraction']),
    context,
    contextWordStart: asInteger(row['context_word_start']),
    savedAt,
  };
};

/** A saved word, assembled from its item row and the occurrences it owns. */
export const parseSavedWordRow = (
  row: StoredRow,
  occurrences: readonly SavedOccurrence[],
): SavedWord | null => {
  const id = asText(row['id']);
  const normalized = asText(row['normalized_word']);
  const display = asText(row['display_word']);
  const raw = asText(row['raw_word']);
  const savedAt = asText(row['created_at']);
  const lookupStatus = LOOKUP_STATUSES.find((candidate) => candidate === row['lookup_status']);

  if (
    id === null ||
    normalized === null ||
    display === null ||
    raw === null ||
    savedAt === null ||
    lookupStatus === undefined
  ) {
    return null;
  }

  const resolvedByValue = row['resolved_by'];
  const resolvedBy = RESOLUTIONS.find((candidate) => candidate === resolvedByValue) ?? null;

  if (resolvedByValue !== null && resolvedByValue !== undefined && resolvedBy === null) {
    return null;
  }

  const occurrenceCount = asInteger(row['occurrence_count']) ?? occurrences.length;

  return {
    id,
    word: {
      raw,
      display,
      normalized,
      joinedAcrossLines: asInteger(row['joined_across_lines']) === 1,
    },
    headword: asOptionalText(row['headword']),
    resolvedBy,
    lookupStatus,
    shortDefinition: asOptionalText(row['short_definition']),
    snapshot: parseSnapshot(row['snapshot_json']),
    source: row['provider'] === undefined || row['provider'] === null ? null : parseSource(row),
    occurrences,
    savedAt,
    occurrenceCount,
  };
};
