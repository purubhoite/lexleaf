import {
  annotationsFileName,
  annotationsToMarkdown,
  EMPTY_ANNOTATIONS,
  isEmptyAnnotations,
  parseDocumentAnnotations,
  type AnnotationsExportOutcome,
  type DocumentAnnotations,
} from '@core/annotations/annotations';

/**
 * Where highlights, notes and bookmarks are kept.
 *
 * One JSON file in the application's own data folder, beside the reading
 * state and the saved words. It is deliberately not part of the reading
 * state: that file forgets a book when it drops off the recent list or the
 * reader removes it from there, and a reader's notes must outlive both.
 *
 * The file is read once, on first use, and held in memory. Every change
 * rewrites it whole, to a temporary file that is then renamed over the
 * real one, so a crash mid-write leaves the previous file intact. Writes
 * are queued, so two changes in quick succession cannot interleave.
 */

export const ANNOTATIONS_FILE = 'annotations.json';

const FILE_VERSION = 1;
const MAX_DOCUMENT_ID_LENGTH = 200;
const MAX_NAME_LENGTH = 300;

/** Keys that would reach an object's prototype rather than its contents. */
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);

export const isDocumentId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_DOCUMENT_ID_LENGTH &&
  !FORBIDDEN_IDS.has(value);

interface StoredDocument {
  readonly name: string;
  readonly annotations: DocumentAnnotations;
}

export interface AnnotationFileSystem {
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface AnnotationStoreOptions {
  readonly filePath: string;
  readonly fileSystem: AnnotationFileSystem;
  readonly onDiagnostic?: (message: string) => void;
}

export interface AnnotationStore {
  load(documentId: string): Promise<DocumentAnnotations>;
  save(documentId: string, name: string, annotations: unknown): Promise<boolean>;
  nameOf(documentId: string): Promise<string | null>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseFile = (serialized: string): Map<string, StoredDocument> => {
  const documents = new Map<string, StoredDocument>();

  let value: unknown;

  try {
    value = JSON.parse(serialized);
  } catch {
    return documents;
  }

  if (!isObject(value) || !isObject(value['documents'])) {
    return documents;
  }

  for (const [id, raw] of Object.entries(value['documents'])) {
    if (!isDocumentId(id) || !isObject(raw)) {
      continue;
    }

    const annotations = parseDocumentAnnotations(raw);

    if (!isEmptyAnnotations(annotations)) {
      documents.set(id, {
        name: typeof raw['name'] === 'string' ? raw['name'].slice(0, MAX_NAME_LENGTH) : '',
        annotations,
      });
    }
  }

  return documents;
};

const serializeFile = (documents: ReadonlyMap<string, StoredDocument>): string => {
  const out: Record<string, unknown> = {};

  for (const [id, stored] of documents) {
    out[id] = { name: stored.name, ...stored.annotations };
  }

  return `${JSON.stringify({ version: FILE_VERSION, documents: out }, null, 2)}\n`;
};

export const createAnnotationStore = ({
  filePath,
  fileSystem,
  onDiagnostic,
}: AnnotationStoreOptions): AnnotationStore => {
  let loaded: Promise<Map<string, StoredDocument>> | null = null;
  let writing: Promise<unknown> = Promise.resolve();

  const documents = (): Promise<Map<string, StoredDocument>> => {
    loaded ??= fileSystem.read(filePath).then(parseFile, () => new Map<string, StoredDocument>());

    return loaded;
  };

  const persist = (all: ReadonlyMap<string, StoredDocument>): Promise<boolean> => {
    const contents = serializeFile(all);
    const temporary = `${filePath}.tmp`;

    const attempt = writing.then(async (): Promise<boolean> => {
      try {
        await fileSystem.write(temporary, contents);
        await fileSystem.rename(temporary, filePath);

        return true;
      } catch {
        onDiagnostic?.('Highlights and bookmarks could not be written.');

        return false;
      }
    });

    writing = attempt;

    return attempt;
  };

  return {
    load: async (documentId) =>
      (await documents()).get(documentId)?.annotations ?? EMPTY_ANNOTATIONS,
    nameOf: async (documentId) => (await documents()).get(documentId)?.name ?? null,
    save: async (documentId, name, raw) => {
      const all = await documents();
      const annotations = parseDocumentAnnotations(raw);

      if (isEmptyAnnotations(annotations)) {
        if (!all.has(documentId)) {
          return true;
        }

        all.delete(documentId);
      } else {
        all.set(documentId, { name: name.slice(0, MAX_NAME_LENGTH), annotations });
      }

      return persist(all);
    },
  };
};

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

export interface AnnotationExportOptions {
  readonly store: AnnotationStore;
  /** Asks the reader where to write; `null` when they close the window. */
  readonly chooseDestination: (suggestedName: string) => Promise<string | null>;
  readonly write: (path: string, contents: string) => Promise<void>;
}

/**
 * Writes one book's highlights, notes and bookmarks to a file the reader
 * picks. The window says which book; what is written comes from the store,
 * never from the window.
 */
export const exportAnnotations = async (
  documentId: string,
  { store, chooseDestination, write }: AnnotationExportOptions,
): Promise<AnnotationsExportOutcome> => {
  try {
    const annotations = await store.load(documentId);
    const count = annotations.highlights.length + annotations.bookmarks.length;

    if (count === 0) {
      return { status: 'empty' };
    }

    const name = (await store.nameOf(documentId)) ?? 'book';
    const destination = await chooseDestination(annotationsFileName(name));

    if (destination === null) {
      return { status: 'cancelled' };
    }

    await write(destination, annotationsToMarkdown(name, annotations));

    return { status: 'exported', count };
  } catch {
    return { status: 'failed' };
  }
};
