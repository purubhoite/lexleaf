import { lookUpWord } from '../lookupPipeline';
import { attributionFrom, parseDictionaryManifest, type DictionaryManifest } from '../manifest';
import { morphologyTablesFrom } from '../morphology';
import type {
  DictionaryPartOfSpeech,
  DictionaryPronunciation,
  DictionaryProvider,
  DictionaryQuery,
  DictionaryResult,
  DictionaryStore,
  MorphologyTables,
  StoredEntry,
  StoredSense,
} from '../types';
import { DictionaryArtifactError, readDictionaryIndex, type DictionaryIndex } from './binaryIndex';

/**
 * The Open English WordNet adapter.
 *
 * It turns four files — a JSONL payload, a binary index, the morphological
 * exception lists and the manifest — into the `DictionaryProvider` port. All
 * file handling is injected: this module never imports `node:fs`, so the
 * core stays free of a runtime (ADR-012) and the whole adapter can be
 * exercised over byte arrays in tests.
 */

/** Positional reads over a file-like thing. */
export interface RandomAccessBytes {
  readonly size: number;
  /**
   * Reads exactly `length` bytes at `offset`.
   *
   * @throws when the range cannot be read in full
   */
  read(offset: number, length: number): Uint8Array;
}

/** Everything the provider needs, supplied by the host process. */
export interface DictionaryArtifact {
  readonly index: Uint8Array;
  readonly payload: RandomAccessBytes;
  readonly manifestText: string;
  readonly morphologyText: string;
  close(): void;
}

export interface ProviderOptions {
  /** How many parsed entries to keep. Purely a speed concern. */
  readonly cacheSize?: number;
  /** Main-process diagnostics. Never reaches the renderer. */
  readonly onDiagnostic?: (message: string) => void;
}

const DEFAULT_CACHE_SIZE = 256;

const PART_OF_SPEECH: Readonly<Record<string, DictionaryPartOfSpeech>> = {
  n: 'noun',
  v: 'verb',
  a: 'adjective',
  r: 'adverb',
};

const decoder = new TextDecoder('utf-8', { fatal: true });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringList = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];

const parsePronunciations = (value: unknown): readonly DictionaryPronunciation[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const pronunciations: DictionaryPronunciation[] = [];

  for (const candidate of value) {
    if (!isObject(candidate)) {
      continue;
    }

    const written = candidate['i'];
    const variety = candidate['v'];

    if (typeof written !== 'string' || written.length === 0) {
      continue;
    }

    pronunciations.push({
      value: written,
      variety: variety === 'US' || variety === 'GB' ? variety : 'unspecified',
    });
  }

  return pronunciations;
};

/**
 * Parses one payload line.
 *
 * Returns `null` for anything that is not a well-formed record. A malformed
 * line is a data defect, and the only safe response is to behave as though
 * the entry were absent — never to show half of it as a definition.
 */
export const parseEntryRecord = (key: string, line: string): StoredEntry | null => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isObject(parsed) || !Array.isArray(parsed['s'])) {
    return null;
  }

  const senses: StoredSense[] = [];

  for (const candidate of parsed['s']) {
    if (!isObject(candidate)) {
      continue;
    }

    const part = PART_OF_SPEECH[String(candidate['p'])];
    const definition = candidate['d'];
    const written = candidate['w'];

    if (part === undefined || typeof definition !== 'string' || definition.length === 0) {
      continue;
    }

    senses.push({
      partOfSpeech: part,
      definition,
      examples: stringList(candidate['x']),
      synonyms: stringList(candidate['y']),
      writtenForm: typeof written === 'string' && written.length > 0 ? written : key,
    });
  }

  if (senses.length === 0) {
    return null;
  }

  return { key, senses, pronunciations: parsePronunciations(parsed['pr']) };
};

/** A least-recently-used cache of parsed entries. */
const createCache = (
  capacity: number,
): {
  get: (key: string) => StoredEntry | null | undefined;
  set: (key: string, value: StoredEntry | null) => void;
} => {
  const entries = new Map<string, StoredEntry | null>();

  return {
    get: (key: string): StoredEntry | null | undefined => {
      if (!entries.has(key)) {
        return undefined;
      }

      const value = entries.get(key) ?? null;

      // Re-inserting moves the key to the end of the iteration order, which
      // is what makes the first key the least recently used one.
      entries.delete(key);
      entries.set(key, value);

      return value;
    },

    set: (key: string, value: StoredEntry | null): void => {
      entries.set(key, value);

      if (entries.size > capacity) {
        const oldest = entries.keys().next();

        if (!oldest.done) {
          entries.delete(oldest.value);
        }
      }
    },
  };
};

const parseMorphology = (contents: string): MorphologyTables | null => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }

  if (!isObject(parsed) || !isObject(parsed['exceptions'])) {
    return null;
  }

  return morphologyTablesFrom(parsed['exceptions']);
};

export interface WordNetProvider extends DictionaryProvider {
  readonly manifest: DictionaryManifest;
  /** Number of indexed headwords; reported in diagnostics. */
  readonly headwordCount: number;
}

/**
 * Opens an artifact and returns a provider over it.
 *
 * @throws DictionaryArtifactError when the artifact is unusable; the caller
 *   maps that to an `unavailable` result with the carried reason
 */
export const openWordNetProvider = (
  artifact: DictionaryArtifact,
  options: ProviderOptions = {},
): WordNetProvider => {
  const manifest = parseDictionaryManifest(artifact.manifestText);

  if (manifest === null) {
    artifact.close();
    throw new DictionaryArtifactError('corrupt', 'manifest did not validate');
  }

  const tables = parseMorphology(artifact.morphologyText);

  if (tables === null) {
    artifact.close();
    throw new DictionaryArtifactError('corrupt', 'morphology tables did not validate');
  }

  let index: DictionaryIndex;

  try {
    index = readDictionaryIndex(artifact.index, artifact.payload.size);
  } catch (error: unknown) {
    artifact.close();
    throw error;
  }

  const cache = createCache(options.cacheSize ?? DEFAULT_CACHE_SIZE);
  const attribution = attributionFrom(manifest);
  let open = true;

  const store: DictionaryStore = {
    get(key: string): StoredEntry | null {
      if (!open) {
        throw new DictionaryArtifactError('unreadable', 'provider is closed');
      }

      const cached = cache.get(key);

      if (cached !== undefined) {
        return cached;
      }

      const record = index.find(key);
      let entry: StoredEntry | null = null;

      if (record !== null) {
        const bytes = artifact.payload.read(record.valueOffset, record.valueLength);

        try {
          entry = parseEntryRecord(key, decoder.decode(bytes));
        } catch {
          entry = null;
        }

        if (entry === null) {
          options.onDiagnostic?.(`dictionary payload record for "${key}" did not validate`);
        }
      }

      cache.set(key, entry);

      return entry;
    },
  };

  return {
    manifest,
    headwordCount: index.count,

    lookUp(query: DictionaryQuery): DictionaryResult {
      try {
        return lookUpWord(query, { store, tables, attribution });
      } catch (error: unknown) {
        const reason = error instanceof DictionaryArtifactError ? error.reason : 'unreadable';

        options.onDiagnostic?.(
          `dictionary lookup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );

        return { status: 'unavailable', reason };
      }
    },

    close(): void {
      if (open) {
        open = false;
        artifact.close();
      }
    },
  };
};
